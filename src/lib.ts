// AgentExec as a library: one workspace's tools over MCP's Streamable HTTP, for a host to serve
// under any path of its own. The host decides who may reach it.

import { realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Reach } from "./files.ts";
import { createHostFiles } from "./host.ts";
import { createServer, TOOLS } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { VERSION } from "./version.ts";

/**
 * What happens to a terminal, as it happens. `id` is the session id its answers carry. `by` is the
 * way in it came: `agent` through a tool, `person` through the host. One with `tty` is a shell on
 * a terminal device, whose output is one stream and has no `stream`.
 */
export type CommandEvent =
  | {
      type: "start";
      id: string;
      by: "agent" | "person";
      cmd: string;
      workdir: string;
      tty: boolean;
      at: string;
    }
  | { type: "output"; id: string; stream?: "stdout" | "stderr"; text: string }
  | { type: "exit"; id: string; exitCode: number; at: string };

/** A terminal: a command the agent started, or a shell a person opened. */
export interface Terminal {
  id: string;
  by: "agent" | "person";
  cmd: string;
  workdir: string;
  tty: boolean;
  /** When it started. */
  at: string;
  /** The end of what it has written so far: its last 65,536 characters. */
  output: string;
  /** These two once it has ended. */
  exitCode?: number;
  endedAt?: string;
}

/**
 * The terminals for the host itself: what a person sees and does beside the agent. Each refuses
 * with an error whose message says why.
 */
export interface HostTerminals {
  /** Every terminal, the oldest first: those running, and the last 64 that ended. */
  list(): Terminal[];
  /**
   * Start a person's login shell in the workspace, on a terminal device of this size, and give
   * its id. It needs the `terminal` level and the `pty` option, and counts among the 64 running.
   */
  open(size: { columns: number; rows: number }): string;
  /**
   * Type into a running terminal, the agent's included. In a command, Ctrl-C interrupts it and
   * Ctrl-D ends its input, as for `write_stdin`.
   */
  write(id: string, text: string): void;
  /** Give a shell's terminal device a new size. A command has none. */
  resize(id: string, columns: number, rows: number): void;
  /**
   * End a terminal: an interrupt, or a hangup for a shell, then a kill a second later. It
   * resolves once the terminal has ended or been killed, and one killed is listed as ended a
   * moment after. A program in a shell that ignores the hangup outlives it.
   */
  stop(id: string): Promise<void>;
}

/**
 * A process on a terminal device, as much of one as is used.
 * Its exit comes after its last data.
 */
export interface Pty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}
/** Starts a process on a terminal device. `spawn` of `node-pty` is one. */
export type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string | undefined>;
  },
) => Pty;

/** One entry of a folder. A link is not followed: its size and date are its own. */
export interface FileEntry {
  name: string;
  kind: "file" | "folder" | "link";
  size: number;
  modifiedAt: string;
}

/** A file that changed, by its path from the workspace. */
export interface FileChange {
  path: string;
  size: number;
  modifiedAt: string;
}
/** The files that changed after a time. */
export interface FileChanges {
  /** The newest thousand, the newest first. */
  changes: FileChange[];
  /** Whether there were more than these. */
  more: boolean;
}

/** A file being written a part at a time. Nothing is at its path until `finish`. */
export interface FileUpload {
  /** Add the next part. */
  write(bytes: Uint8Array): Promise<void>;
  /** Put the file in place, whole, over any that was there and with that one's permissions. */
  finish(): Promise<{ size: number; modifiedAt: string }>;
  /** Give up, leaving what was there. */
  abort(): Promise<void>;
}

/** The workspace's files for the host itself. Paths are from the workspace, or absolute in it. */
export interface HostFiles {
  /** A folder's entries, folders first, the first thousand. `more` says there were others. */
  list(path?: string): Promise<{ entries: FileEntry[]; more: boolean }>;
  /**
   * `length` bytes of a file from `offset`, with its whole size and its date. Fewer bytes come
   * back at its end, and none past it. A `length` under 1 or over 1,048,576 is refused, as is
   * anything that isn't a file.
   */
  read(
    path: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; size: number; modifiedAt: string }>;
  /**
   * The files modified after a time, in whole milliseconds: the newest thousand, the newest first.
   * It skips what `.gitignore` files ignore, `.git`, `node_modules` and links, and a file that was
   * removed isn't one of them.
   */
  changed(since: Date): Promise<FileChanges>;
  /** Start writing a file, in a folder that is there. Refused at the `read` level. */
  upload(path: string): Promise<FileUpload>;
}

/**
 * A tool the host adds to AgentExec's own, for what it knows of the workspace and AgentExec
 * doesn't. It takes no input and answers text, and it is offered at every level.
 */
export interface ExtraTool {
  name: string;
  /** What the agent reads to know when to call it. */
  description: string;
  /** Whether it only reads, which is what an agent's client is told. Not unless it says so. */
  readOnly?: boolean;
  /** Its answer. One that throws is answered as a refusal, with the error's message. */
  call(): string | Promise<string>;
}

export interface AgentExecOptions {
  /** Where commands start and relative paths begin, and the folder the file tools are kept to. */
  workspace: string;
  /**
   * Where the file tools reach: the workspace, which is the default, or the whole machine, with
   * relative paths still from the workspace. Either way it is a check of this program's, not a
   * boundary: commands reach whatever the user running them can. A host's own files stay within
   * the workspace.
   */
  reach?: Reach;
  /**
   * Which tools it offers, each level containing the one before, and whether the host may write
   * files: not at `read`, which is the default.
   */
  level?: "read" | "files" | "terminal";
  /**
   * What a person's shell runs on. AgentExec brings no terminal device of its own: without this,
   * `terminals.open` is refused, and everything else is as it is.
   */
  pty?: PtySpawn;
  /** Tools the host adds. A name of one of AgentExec's seven, or one given twice, is refused. */
  extraTools?: ExtraTool[];
}

export interface AgentExec {
  /** Answer one MCP request. Pass `body` if the host has already parsed it. */
  handle(request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void>;
  /**
   * Hear each terminal start, write and exit as it happens, whatever the agent has asked for so
   * far. Returns the way to stop listening. What a terminal writes still reaches the agent.
   */
  onCommand(listener: (event: CommandEvent) => void): () => void;
  /** The terminals, to list, open, type into, size and stop. */
  terminals: HostTerminals;
  /**
   * The workspace's files for the host itself, in bytes and with dates, kept inside the workspace
   * as the tools are. None of it is a tool, and the agent's tools don't change. Each refuses with
   * an error whose message says why.
   */
  files: HostFiles;
  /** Stop every terminal still running, and give up every upload still open. */
  close(): Promise<void>;
}

/**
 * One workspace's tools. Each request is answered on its own, as MCP's stateless transport does,
 * and commands outlive requests, so a session id from one call works in the next.
 */
export function createAgentExec(options: AgentExecOptions): AgentExec {
  const root = realpathSync(resolve(options.workspace));
  const level = options.level ?? "read";
  const listeners = new Set<(event: CommandEvent) => void>();
  const sessions = new Sessions(
    root,
    (event) => {
      for (const listener of listeners)
        try {
          listener(event);
        } catch {
          // A listener that fails doesn't stop the terminal or the others.
        }
    },
    options.pty,
  );
  const host = createHostFiles(root, level);
  const extraTools = [...(options.extraTools ?? [])];
  const names = new Set<string>(TOOLS);
  for (const { name } of extraTools) {
    if (names.has(name)) throw new Error(`There is already a tool called ${name}.`);
    names.add(name);
  }
  return {
    async handle(request, response, body) {
      const server = createServer(root, sessions, VERSION, level, extraTools, options.reach);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.once("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    },
    onCommand(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    files: host.files,
    terminals: {
      list: () => sessions.list(),
      open({ columns, rows }) {
        if (level !== "terminal") throw new Error("A shell needs the terminal level.");
        return sessions.open(columns, rows);
      },
      write: (id, text) => sessions.type(id, text),
      resize: (id, columns, rows) => sessions.resize(id, columns, rows),
      stop: (id) => sessions.stop(id),
    },
    async close() {
      await Promise.all([sessions.stopAll(), host.close()]);
    },
  };
}
