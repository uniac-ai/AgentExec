// Commands and their sessions. A command runs for as long as it waits, then yields with a session
// id and keeps running. The behaviour follows Codex's exec_command and write_stdin; see NOTICE.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { CommandEvent } from "./lib.ts";
import { CHARS_PER_TOKEN, cut, Pending } from "./output.ts";

export const MIN_YIELD_MS = 250;
export const MAX_YIELD_MS = 30_000;
export const DEFAULT_YIELD_MS = 10_000;
/** A poll with nothing to type waits at least this long. */
export const MIN_POLL_MS = 5_000;
/** A write waits this long for what it caused. */
export const WRITE_YIELD_MS = 250;
/** Commands running at once; one past it is refused, and none is ever evicted. */
export const MAX_RUNNING = 64;
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
  child: ChildProcessWithoutNullStreams;
  pending: Pending;
  /** Set once it has exited and its output has arrived. */
  exitCode?: number;
  ended: Promise<void>;
}

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

export class Sessions {
  readonly #sessions = new Map<string, Session>();
  readonly #root: string;
  readonly #emit: (event: CommandEvent) => void;

  constructor(root: string, emit: (event: CommandEvent) => void = () => {}) {
    this.#root = root;
    this.#emit = emit;
  }

  /** Run `cmd` in a login shell, in `workdir` or the workspace. */
  async exec(input: {
    cmd: string;
    workdir?: string | undefined;
    yield_time_ms?: number | undefined;
    max_output_tokens?: number | undefined;
  }): Promise<Answer> {
    const running = [...this.#sessions.values()].filter((s) => s.exitCode === undefined);
    if (running.length >= MAX_RUNNING)
      throw new ExecRefused(`${MAX_RUNNING} commands are running. Wait for one, or stop one.`);
    const started = Date.now();
    const session = this.#start(input.cmd, input.workdir ?? this.#root);
    const wait = clamp(input.yield_time_ms ?? DEFAULT_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS);
    return this.#after(session, wait, started, input.max_output_tokens);
  }

  /**
   * Type into a running command, or with no `chars` wait and see what it has written. Ctrl-C
   * (`\u0003`) interrupts it and Ctrl-D (`\u0004`) ends its input.
   */
  async write(input: {
    session_id: string;
    chars?: string | undefined;
    yield_time_ms?: number | undefined;
    max_output_tokens?: number | undefined;
  }): Promise<Answer> {
    const session = this.#sessions.get(input.session_id);
    if (!session) throw new ExecRefused(`No session ${input.session_id.slice(0, 64)} is running.`);
    const started = Date.now();
    const chars = input.chars ?? "";
    if (session.exitCode === undefined) this.#type(session, chars);
    const wait = chars
      ? clamp(input.yield_time_ms ?? WRITE_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS)
      : clamp(input.yield_time_ms ?? MIN_POLL_MS, MIN_POLL_MS, MAX_YIELD_MS);
    return this.#after(session, wait, started, input.max_output_tokens);
  }

  /** Stop every command: a polite signal, then a certain one. */
  async stopAll() {
    const running = [...this.#sessions.values()].filter((s) => s.exitCode === undefined);
    for (const session of running) this.#signal(session, "SIGTERM");
    await Promise.race([
      Promise.all(running.map((s) => s.ended)),
      new Promise((done) => setTimeout(done, KILL_AFTER_MS)),
    ]);
    for (const session of running)
      if (session.exitCode === undefined) this.#signal(session, "SIGKILL");
  }

  #start(cmd: string, cwd: string): Session {
    const child = spawn(process.env.SHELL || "/bin/bash", ["-lc", cmd], {
      cwd,
      stdio: "pipe",
      // Its own process group, so a signal reaches what it started.
      detached: true,
    });
    const pending = new Pending();
    const id = `s_${randomBytes(9).toString("hex")}`;
    const session = { id, child, pending } as Session;
    this.#emit({ type: "start", id, cmd, workdir: cwd, at: new Date().toISOString() });
    for (const [name, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => {
        const text = decoder.write(chunk);
        pending.add(text);
        if (text) this.#emit({ type: "output", id, stream: name, text });
      });
    }
    child.stdin.on("error", () => {});
    session.ended = new Promise<void>((done) => {
      const finish = (code: number) => {
        if (session.exitCode !== undefined) return;
        session.exitCode = code;
        this.#emit({ type: "exit", id, exitCode: code, at: new Date().toISOString() });
        done();
      };
      child.once("error", (error) => {
        pending.add(`${error.message}\n`);
        this.#emit({ type: "output", id, stream: "stderr", text: `${error.message}\n` });
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
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  #type(session: Session, chars: string) {
    for (const part of chars.split(/(\p{Cc})/u)) {
      if (part === "\u0003") this.#signal(session, "SIGINT");
      else if (part === "\u0004") session.child.stdin.end();
      else if (part && session.child.stdin.writable) session.child.stdin.write(part);
    }
  }

  #signal(session: Session, signal: NodeJS.Signals) {
    try {
      if (session.child.pid) process.kill(-session.child.pid, signal);
    } catch {
      // It has gone already.
    }
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
    if (exited) this.#sessions.delete(session.id);
    return {
      exit_code: exited ? (session.exitCode as number) : null,
      seconds: Math.round(Date.now() - started) / 1000,
      session_id: exited ? null : session.id,
      text: cut(session.pending.take(), (maxTokens ?? DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN),
    };
  }
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
