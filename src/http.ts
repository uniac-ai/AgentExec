// AgentExec over HTTP on its own: loopback only, with a bearer token. To serve it anywhere else,
// mount the library behind something that does TLS.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Reach } from "./files.ts";
import { createAgentExec } from "./lib.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const digest = (text: string) => createHash("sha256").update(text).digest();

/** `host:port`, or `[v6]:port`. */
function parseListen(listen: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(listen);
  if (!match) throw new Error("--http takes host:port.");
  return { host: (match[1] ?? match[2]) as string, port: Number(match[3]) };
}

export async function serveHttp(
  listen: string,
  workspace: string,
  level: "read" | "files" | "terminal",
  reach: Reach,
) {
  const { host, port } = parseListen(listen);
  if (!LOOPBACK.has(host))
    throw new Error("--http listens on loopback only: AgentExec has no TLS of its own.");
  const token = process.env.AGENTEXEC_TOKEN;
  if (!token) throw new Error("Set AGENTEXEC_TOKEN to the bearer token clients must send.");
  const expected = digest(`Bearer ${token}`);
  const exec = createAgentExec({ workspace, level, reach });
  const server = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp")
      return void response.writeHead(404).end();
    if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected))
      return void response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    exec.handle(request, response).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(port, host, done);
  });
  const bound = server.address() as AddressInfo;
  const shown = bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
  process.stderr.write(`Listening on http://${shown}:${bound.port}/mcp\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await exec.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());
}
