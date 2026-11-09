// AgentExec: `agentexec [--workspace DIR] [--level read|files|terminal] [--http HOST:PORT]` serves
// MCP over stdio, or over Streamable HTTP with a bearer token.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
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
      http: { type: "string" },
    },
  });
  const level = (values.level ?? "read") as Level;
  if (!LEVELS.includes(level)) throw new Error(`--level is one of ${LEVELS.join(", ")}.`);
  const root = realpathSync(resolve(values.workspace ?? process.cwd()));
  if (values.http) return serveHttp(values.http, root, level);
  const sessions = new Sessions(root);
  const server = createServer(root, sessions, VERSION, level);
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
