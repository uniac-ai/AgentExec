// AgentExec: `agentexec [--workspace DIR] [--level read|files|terminal] [--reach workspace|machine]
// [--http HOST:PORT]` serves MCP over stdio, or over Streamable HTTP with a bearer token.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Reach } from "./files.ts";
import { serveHttp } from "./http.ts";
import "./search.ts";
import { createServer, LEVELS, type Level } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { VERSION } from "./version.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string" },
      level: { type: "string" },
      reach: { type: "string" },
      http: { type: "string" },
    },
  });
  const level = (values.level ?? "read") as Level;
  if (!LEVELS.includes(level)) throw new Error(`--level is one of ${LEVELS.join(", ")}.`);
  const reach = (values.reach ?? "workspace") as Reach;
  if (reach !== "workspace" && reach !== "machine")
    throw new Error("--reach is workspace or machine.");
  const root = realpathSync(resolve(values.workspace ?? process.cwd()));
  if (values.http) return serveHttp(values.http, root, level, reach);
  const sessions = new Sessions(root);
  const server = createServer(root, sessions, VERSION, level, { reach });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await sessions.stopAll();
    process.exit(0);
  };
  const transport = new StdioServerTransport();
  transport.onclose = () => void stop();
  process.stdin.once("end", () => void stop());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());
  await server.connect(transport);
}

if (isMainThread)
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
