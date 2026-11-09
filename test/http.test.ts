// HTTP on its own, and mounted as a library by a host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectHttp, environment, SERVER, startHttp, TOKEN } from "./clients.ts";

const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");
const space = (t: test.TestContext) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
};
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "x", version: "1" },
  },
};
const post = (url: string, headers: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(initialize),
  });

test("HTTP takes only the right bearer token, and only at /mcp", async (t) => {
  const { url, child } = await startHttp(space(t), "read");
  t.after(() => child.kill("SIGTERM"));
  assert.equal((await post(url, {})).status, 401);
  assert.equal((await post(url, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post(url.replace("/mcp", "/other"), {})).status, 404);
  assert.equal((await post(url, { Authorization: `Bearer ${TOKEN}` })).status, 200);
});

for (const [why, args, env] of [
  ["without a token", ["--http", "127.0.0.1:0"], {}],
  ["off loopback", ["--http", "0.0.0.0:0"], { AGENTEXEC_TOKEN: TOKEN }],
] as const)
  test(`HTTP refuses to start ${why}`, async (t) => {
    const workspace = space(t);
    const child = spawn(process.execPath, [SERVER, "--workspace", workspace, ...args], {
      env: { ...environment(workspace), ...env },
    });
    const [code] = (await once(child, "exit")) as [number];
    assert.equal(code, 1);
  });

test("a host mounts it under its own path, sessions last across requests, search works", async (t) => {
  const workspace = space(t);
  writeFileSync(join(workspace, "a.txt"), "needle\n");
  const { createAgentExec } = (await import(LIBRARY)) as typeof import("../src/lib.ts");
  const exec = createAgentExec({ workspace, level: "terminal" });
  const host = createServer((request, response) => {
    assert.equal(request.url, "/v1/computers/one/mcp/computer");
    void exec.handle(request, response);
  }).listen(0, "127.0.0.1");
  await once(host, "listening");
  t.after(async () => {
    host.close();
    await exec.close();
  });
  const { port } = host.address() as AddressInfo;
  const client = await connectHttp(`http://127.0.0.1:${port}/v1/computers/one/mcp/computer`, "-");
  t.after(() => client.close());
  assert.equal((await client.call("search", { pattern: "needle" })).text, "a.txt:1:needle");
  const started = await client.call("exec_command", { cmd: "cat", yield_time_ms: 250 });
  const session_id = /session_id: (\S+)/.exec(started.text)?.[1] as string;
  assert.match(session_id, /^s_/);
  const typed = await client.call("write_stdin", {
    session_id,
    chars: "hi\n",
    yield_time_ms: 2000,
  });
  assert.match(typed.text, /text:\nhi\n$/);
});
