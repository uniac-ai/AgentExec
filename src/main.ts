// AgentExec: `agentexec [--workspace DIR]` serves MCP over stdio.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { serveSearch } from "./search.ts";
import { createServer } from "./server.ts";
import { Sessions } from "./sessions.ts";

const VERSION = "0.0.1";

async function main() {
  const { values } = parseArgs({ options: { workspace: { type: "string" } } });
  const root = realpathSync(resolve(values.workspace ?? process.cwd()));
  const sessions = new Sessions(root);
  const server = createServer(root, sessions, VERSION);
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

if (!serveSearch())
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
