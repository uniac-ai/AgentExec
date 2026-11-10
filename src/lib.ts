// AgentExec as a library: one workspace's tools over MCP's Streamable HTTP, for a host to serve
// under any path of its own. The host decides who may reach it.

import { realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createHostFiles } from "./host.ts";
import { createServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { VERSION } from "./version.ts";

/** What happens to a command, as it happens. `id` is the session id its answers carry. */
export type CommandEvent =
  | { type: "start"; id: string; cmd: string; workdir: string; at: string }
  | { type: "output"; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "exit"; id: string; exitCode: number; at: string };

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
export interface FileChanges {
  /** The newest first. */
  changes: FileChange[];
  /** Whether there were more than these. */
  more: boolean;
}

/** A file being written a part at a time. Nothing is at its path until `finish`. */
export interface FileUpload {
  /** Add the next part. */
  write(bytes: Uint8Array): Promise<void>;
  /** Put the file in place, whole, over any that was there. */
  finish(): Promise<{ size: number; modifiedAt: string }>;
  /** Give up, leaving what was there. */
  abort(): Promise<void>;
}

/** The workspace's files for the host itself. Paths are from the workspace, or absolute in it. */
export interface HostFiles {
  /** A folder's entries, folders first, the first thousand. `more` says there were others. */
  list(path?: string): Promise<{ entries: FileEntry[]; more: boolean }>;
  /**
   * Up to `length` bytes of a file from `offset`, at most 1,048,576 a time, with its whole size
   * and its date. Fewer bytes come back at its end, and none past it.
   */
  read(
    path: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; size: number; modifiedAt: string }>;
  /**
   * The files modified after a time, the newest first, up to a thousand. It skips what the search
   * skips, and a file that was removed isn't one of them.
   */
  changed(since: Date): Promise<FileChanges>;
  /** Start writing a file. Refused at the `read` level. */
  upload(path: string): Promise<FileUpload>;
}

export interface AgentExecOptions {
  /** The folder its file tools are kept to, and where commands start. */
  workspace: string;
  /** Which tools it offers, each level containing the one before. `read` by default. */
  level?: "read" | "files" | "terminal";
}

export interface AgentExec {
  /** Answer one MCP request. Pass `body` if the host has already parsed it. */
  handle(request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void>;
  /**
   * Hear each command start, write and exit as it happens, whatever the agent has asked for so
   * far. Returns the way to stop listening. What a command writes still reaches the agent.
   */
  onCommand(listener: (event: CommandEvent) => void): () => void;
  /**
   * The workspace's files for the host itself, in bytes and with dates, kept inside the workspace
   * as the tools are. None of it is a tool, and the agent's tools don't change. Each refuses with
   * an error whose message says why.
   */
  files: HostFiles;
  /** Stop every command still running, and give up every upload still open. */
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
  const sessions = new Sessions(root, (event) => {
    for (const listener of listeners)
      try {
        listener(event);
      } catch {
        // A listener that fails doesn't stop the command or the others.
      }
  });
  const host = createHostFiles(root, level);
  return {
    async handle(request, response, body) {
      const server = createServer(root, sessions, VERSION, level);
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
    async close() {
      await Promise.all([sessions.stopAll(), host.close()]);
    },
  };
}
