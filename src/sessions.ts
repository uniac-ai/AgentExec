// The terminals of one workspace, in one list: each command the agent runs, and each shell a person
// opens. A command runs for as long as it waits, then yields with a session id and keeps running.
// That behaviour follows Codex's exec_command and write_stdin; see NOTICE.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { CommandEvent, PtySpawn, Terminal } from "./lib.ts";
import { CHARS_PER_TOKEN, cut, Pending } from "./output.ts";

export const MIN_YIELD_MS = 250;
export const MAX_YIELD_MS = 30_000;
export const DEFAULT_YIELD_MS = 10_000;
/** A poll with nothing to type waits at least this long. */
export const MIN_POLL_MS = 5_000;
/** A write waits this long for what it caused. */
export const WRITE_YIELD_MS = 250;
/** Terminals running at once; one past it is refused, and none is ever evicted. */
export const MAX_RUNNING = 64;
/** Terminals that have ended and are still listed, which bounds what the ended hold. */
export const MAX_ENDED = 64;
/** How much of what a terminal wrote is kept for someone who comes late: some screens of it. */
const KEPT = 64 * 1024;
/** How much of a command `list_sessions` shows. */
const CMD_SHOWN = 200;
/** The most columns or rows a shell's terminal has. */
const MAX_SIZE = 1_000;
/** Sized so an answer fits what a model is usually given of a tool's output. */
export const DEFAULT_MAX_TOKENS = 7_000;
/** After a command exits, how long output still in its pipes has to arrive. */
const DRAIN_MS = 200;
const KILL_AFTER_MS = 1_000;

/** The fixed shape of every answer about a command. */
export interface Answer {
  exit_code: number | null;
  seconds: number;
  session_id: string | null;
  text: string;
}

/** A request that can't be carried out. A command that fails is an answer, not one of these. */
export class ExecRefused extends Error {}

interface Session {
  id: string;
  by: Terminal["by"];
  cmd: string;
  workdir: string;
  tty: boolean;
  at: string;
  /** What it wrote that no answer has carried yet. */
  pending: Pending;
  /** The end of all it wrote, trimmed to `KEPT` when it is twice that. */
  last: string;
  /** Set once it has exited and its output has arrived. */
  exitCode?: number;
  endedAt?: string;
  /** An answer has carried its exit, so `write` no longer knows it. */
  reported?: true;
  ended: Promise<void>;
  type(chars: string): void;
  signal(signal: NodeJS.Signals): void;
  /** Only for one on a terminal device. */
  resize?(columns: number, rows: number): void;
}

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
/** The last `KEPT` characters, never starting with half a surrogate pair. */
const tail = (text: string) => text.slice(-KEPT).replace(/^[\uDC00-\uDFFF]/, "");

export class Sessions {
  readonly #sessions = new Map<string, Session>();
  /** Those that have ended and are still listed, in the order they ended. */
  readonly #ended: Session[] = [];
  readonly #root: string;
  readonly #emit: (event: CommandEvent) => void;
  readonly #pty: PtySpawn | undefined;

  constructor(root: string, emit: (event: CommandEvent) => void = () => {}, pty?: PtySpawn) {
    this.#root = root;
    this.#emit = emit;
    this.#pty = pty;
  }

  /** Run `cmd` in a login shell, in `workdir` or the workspace. */
  async exec(input: {
    cmd: string;
    workdir?: string | undefined;
    yield_time_ms?: number | undefined;
    max_output_tokens?: number | undefined;
  }): Promise<Answer> {
    this.#room();
    const started = Date.now();
    const session = this.#start(input.cmd, input.workdir ?? this.#root);
    const wait = clamp(input.yield_time_ms ?? DEFAULT_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS);
    return this.#after(session, wait, started, input.max_output_tokens);
  }

  /**
   * Type into a running terminal, or with no `chars` wait and see what it has written. In a
   * command, Ctrl-C (`\u0003`) interrupts it and Ctrl-D (`\u0004`) ends its input; a shell on a
   * terminal device is typed into as it is.
   */
  async write(input: {
    session_id: string;
    chars?: string | undefined;
    yield_time_ms?: number | undefined;
    max_output_tokens?: number | undefined;
  }): Promise<Answer> {
    const session = this.#sessions.get(input.session_id);
    if (!session || session.reported)
      throw new ExecRefused(`No session ${input.session_id.slice(0, 64)} is running.`);
    const started = Date.now();
    const chars = input.chars ?? "";
    if (session.exitCode === undefined) session.type(chars);
    const wait = chars
      ? clamp(input.yield_time_ms ?? WRITE_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS)
      : clamp(input.yield_time_ms ?? MIN_POLL_MS, MIN_POLL_MS, MAX_YIELD_MS);
    return this.#after(session, wait, started, input.max_output_tokens);
  }

  /** Every terminal, the oldest first: those running, and the last that ended. */
  list(): Terminal[] {
    return [...this.#sessions.values()].map((session) => ({
      id: session.id,
      by: session.by,
      cmd: session.cmd,
      workdir: session.workdir,
      tty: session.tty,
      at: session.at,
      output: tail(session.last),
      ...(session.exitCode === undefined
        ? {}
        : { exitCode: session.exitCode, endedAt: session.endedAt as string }),
    }));
  }

  /** Start a person's login shell in the workspace, on a terminal device of this size. */
  open(columns: number, rows: number): string {
    if (!this.#pty)
      throw new ExecRefused("A shell needs a terminal device, and this host has none to give.");
    this.#room();
    const size = sized(columns, rows);
    const file = process.env.SHELL || "/bin/bash";
    let shell: ReturnType<PtySpawn>;
    try {
      shell = this.#pty(file, ["-l"], {
        name: "xterm-256color",
        ...size,
        cwd: this.#root,
        env: process.env,
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new ExecRefused(`The shell didn't start: ${why}`);
    }
    const { session, wrote, finish } = this.#begin("person", file, this.#root, true, {
      type: (chars) => shell.write(chars),
      signal(signal) {
        try {
          shell.kill(signal);
        } catch {
          // It has gone already.
        }
      },
      resize: (cols, lines) => shell.resize(cols, lines),
    });
    shell.onData((text) => wrote(text));
    shell.onExit(({ exitCode, signal }) => finish(signal ? 128 + signal : exitCode));
    return session.id;
  }

  /** Type into a running terminal, as `write` does and with no answer. */
  type(id: string, chars: string) {
    this.#running(id).type(chars);
  }

  /** Give a shell's terminal device a new size. */
  resize(id: string, columns: number, rows: number) {
    const session = this.#running(id);
    if (!session.resize) throw new ExecRefused("Only a shell on a terminal device has a size.");
    const size = sized(columns, rows);
    session.resize(size.cols, size.rows);
  }

  /**
   * End one terminal: an interrupt, then a certain signal. It resolves once the terminal has
   * ended or that signal is sent. One that has ended is left alone.
   */
  async stop(id: string) {
    const session = this.#sessions.get(id);
    if (!session) throw new ExecRefused(`No terminal ${id.slice(0, 64)} is here.`);
    await this.#end([session], "SIGINT");
  }

  /** Stop every terminal: a polite signal, then a certain one. */
  async stopAll() {
    await this.#end([...this.#sessions.values()], "SIGTERM");
  }

  async #end(sessions: Session[], polite: NodeJS.Signals) {
    const running = sessions.filter((s) => s.exitCode === undefined);
    // A shell on a terminal device ignores both of the polite ones, and ends when hung up on.
    // Only the shell is signalled: what it runs is hung up on in turn, and may ignore that.
    for (const session of running) session.signal(session.tty ? "SIGHUP" : polite);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map((s) => s.ended)),
      new Promise((done) => {
        timer = setTimeout(done, KILL_AFTER_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const session of running) if (session.exitCode === undefined) session.signal("SIGKILL");
  }

  #room() {
    const running = [...this.#sessions.values()].filter((s) => s.exitCode === undefined);
    if (running.length >= MAX_RUNNING)
      throw new ExecRefused(`${MAX_RUNNING} commands are running. Wait for one, or stop one.`);
  }

  #running(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new ExecRefused(`No terminal ${id.slice(0, 64)} is here.`);
    if (session.exitCode !== undefined) throw new ExecRefused("That terminal has ended.");
    return session;
  }

  /**
   * List a terminal that has just started, with the ways to act on its process, and give the two
   * ways that process reports back.
   */
  #begin(
    by: Terminal["by"],
    cmd: string,
    workdir: string,
    tty: boolean,
    acts: Pick<Session, "type" | "signal" | "resize">,
  ) {
    const id = `s_${randomBytes(9).toString("hex")}`;
    const at = new Date().toISOString();
    let done = () => {};
    const session: Session = {
      id,
      by,
      cmd,
      workdir,
      tty,
      at,
      pending: new Pending(),
      last: "",
      ended: new Promise<void>((resolve) => {
        done = resolve;
      }),
      ...acts,
    };
    this.#sessions.set(id, session);
    this.#emit({ type: "start", id, by, cmd, workdir, tty, at });
    const wrote = (text: string, stream?: "stdout" | "stderr") => {
      if (!text) return;
      session.pending.add(text);
      session.last += text;
      if (session.last.length > 2 * KEPT) session.last = tail(session.last);
      this.#emit({ type: "output", id, ...(stream ? { stream } : {}), text });
    };
    const finish = (exitCode: number) => {
      if (session.exitCode !== undefined) return;
      session.exitCode = exitCode;
      session.endedAt = new Date().toISOString();
      this.#emit({ type: "exit", id, exitCode, at: session.endedAt });
      this.#ended.push(session);
      if (this.#ended.length > MAX_ENDED) {
        // One whose exit no answer has carried is still owed to whoever started it: it goes last.
        const read = this.#ended.findIndex((one) => one.reported);
        const [old] = this.#ended.splice(Math.max(read, 0), 1);
        this.#sessions.delete((old as Session).id);
      }
      done();
    };
    return { session, wrote, finish };
  }

  #start(cmd: string, cwd: string): Session {
    const child = spawn(process.env.SHELL || "/bin/bash", ["-lc", cmd], {
      cwd,
      stdio: "pipe",
      // Its own process group, so a signal reaches what it started.
      detached: true,
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        // It has gone already.
      }
    };
    const type = (chars: string) => {
      for (const part of chars.split(/(\p{Cc})/u)) {
        if (part === "\u0003") signal("SIGINT");
        else if (part === "\u0004") child.stdin.end();
        else if (part && child.stdin.writable) child.stdin.write(part);
      }
    };
    const { session, wrote, finish } = this.#begin("agent", cmd, cwd, false, { type, signal });
    for (const [name, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => wrote(decoder.write(chunk), name));
    }
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      wrote(`${error.message}\n`, "stderr");
      finish(127);
    });
    child.once("exit", (code, signal) => {
      const exitCode = code ?? 128 + (signal ? (SIGNALS[signal] ?? 1) : 1);
      // A process it left in the background can hold the pipes open for good.
      const late = setTimeout(() => finish(exitCode), DRAIN_MS);
      child.once("close", () => {
        clearTimeout(late);
        finish(exitCode);
      });
    });
    return session;
  }

  async #after(session: Session, waitMs: number, started: number, maxTokens?: number) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      session.ended,
      new Promise((done) => {
        timer = setTimeout(done, waitMs);
      }),
    ]);
    clearTimeout(timer);
    const exited = session.exitCode !== undefined;
    if (exited) session.reported = true;
    return {
      exit_code: exited ? (session.exitCode as number) : null,
      seconds: Math.round(Date.now() - started) / 1000,
      session_id: exited ? null : session.id,
      text: cut(session.pending.take(), (maxTokens ?? DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN),
    };
  }
}

/** A size a terminal device can have, or a refusal. */
function sized(columns: number, rows: number) {
  for (const value of [columns, rows])
    if (!Number.isInteger(value) || value < 1 || value > MAX_SIZE)
      throw new ExecRefused(`A terminal has 1 to ${MAX_SIZE} columns and rows.`);
  return { cols: columns, rows };
}

/** An answer as its text: the same four fields, in this order, always. */
export function formatAnswer(answer: Answer): string {
  return [
    `exit_code: ${answer.exit_code ?? "running"}`,
    `seconds: ${answer.seconds}`,
    `session_id: ${answer.session_id ?? "none"}`,
    "text:",
    answer.text,
  ].join("\n");
}

/** A listed terminal as `list_sessions` gives it. */
export interface Listed {
  session_id: string;
  started_by: "agent" | "person";
  since: string;
  exit_code: number | null;
  cmd: string;
}

/** The terminals as `list_sessions` gives them, each command as its first line or its start. */
export function listing(terminals: Terminal[]): Listed[] {
  return terminals.map((one) => {
    const line = (one.cmd.split("\n", 1)[0] as string).slice(0, CMD_SHOWN);
    const shown = line.replace(/[\uD800-\uDBFF]$/, "");
    return {
      session_id: one.id,
      started_by: one.by,
      since: one.at,
      exit_code: one.exitCode ?? null,
      cmd: shown === one.cmd ? shown : `${shown}…`,
    };
  });
}

/** The list as its text: the same five fields for each, a blank line between. */
export function formatSessions(listed: Listed[]): string {
  if (listed.length === 0) return "No sessions.";
  return listed
    .map((one) =>
      [
        `session_id: ${one.session_id}`,
        `started_by: ${one.started_by}`,
        `since: ${one.since}`,
        `exit_code: ${one.exit_code ?? "running"}`,
        `cmd: ${one.cmd}`,
      ].join("\n"),
    )
    .join("\n\n");
}
