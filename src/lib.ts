// AgentExec as a library: one workspace's tools over MCP's Streamable HTTP, for a host to serve
// under any path of its own. The host decides who may reach it.

import { realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { VERSION } from "./version.ts";

export interface AgentExecOptions {
  /** The folder its file tools are kept to, and where commands start. */
  workspace: string;
  /** Which tools it offers, each level containing the one before. `read` by default. */
  level?: "read" | "files" | "terminal";
}

export interface AgentExec {
  /** Answer one MCP request. Pass `body` if the host has already parsed it. */
  handle(request: IncomingMessage, response: ServerResponse, body?: unknown): Promise<void>;
  /** Stop every command still running. */
  close(): Promise<void>;
}

/**
 * One workspace's tools. Each request is answered on its own, as MCP's stateless transport does,
 * and commands outlive requests, so a session id from one call works in the next.
 */
export function createAgentExec(options: AgentExecOptions): AgentExec {
  const root = realpathSync(resolve(options.workspace));
  const level = options.level ?? "read";
  const sessions = new Sessions(root);
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
    close: () => sessions.stopAll(),
  };
}
