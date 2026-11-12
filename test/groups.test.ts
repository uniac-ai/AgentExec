// A caller puts the sessions it starts in a group, and ends the group together.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { pythonPty } from "./pty.ts";

type Library = typeof import("../src/lib.ts");
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");
const Stopped = z.object({ stopped: z.number() });

// A plain shell and an empty home, so nothing of the user's own profile runs.
process.env.SHELL = "/bin/bash";
process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-home-")));
test.after(() => rmSync(process.env.HOME as string, { recursive: true, force: true }));

async function mounted(t: test.TestContext) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const exec = createAgentExec({ workspace, level: "terminal", pty: pythonPty().open });
  const host = createServer((request, response) => void exec.handle(request, response));
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const client = new Client({ name: "groups", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(host.address() as AddressInfo).port}/mcp`),
    ),
  );
  t.after(async () => {
    await client.close();
    host.close();
    await exec.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  /** Start a command that runs on, in a group or in none, and give its session. */
  const running = async (group?: unknown) => {
    const { structuredContent } = await client.callTool({
      name: "exec_command",
      arguments: { cmd: "sleep 30", yield_time_ms: 250 },
      ...(group === undefined ? {} : { _meta: { "agentexec/group": group } }),
    });
    return (structuredContent as { session_id: string }).session_id;
  };
  const stop = (group: string) =>
    client.request({ method: "agentexec/group/stop", params: { group } }, Stopped);
  /** The sessions still running, by id. */
  const alive = () =>
    exec.terminals
      .list()
      .filter((one) => one.exitCode === undefined)
      .map((one) => one.id)
      .sort();
  return { exec, client, running, stop, alive };
}

test("a group's sessions end together, and nothing else does", async (t) => {
  const { exec, running, stop, alive } = await mounted(t);
  const mine = [await running("a"), await running("a")];
  const others = [
    await running("b"),
    await running(),
    exec.terminals.open({ columns: 80, rows: 24 }),
  ];
  assert.deepEqual(alive(), [...mine, ...others].sort());

  assert.deepEqual(await stop("a"), { stopped: 2 });
  assert.deepEqual(alive(), others.sort());
  const ended = exec.terminals.list().filter((one) => mine.includes(one.id));
  assert.deepEqual(
    ended.map((one) => one.exitCode),
    [130, 130],
  );
  // Asked again, or of a group nobody is in, there is nothing to end.
  assert.deepEqual(await stop("a"), { stopped: 0 });
  assert.deepEqual(await stop("nobody"), { stopped: 0 });
});

test("a call still waiting for its command is answered when its group ends", async (t) => {
  const { client, stop, alive } = await mounted(t);
  const began = Date.now();
  const waiting = client.callTool({
    name: "exec_command",
    arguments: { cmd: "sleep 30", yield_time_ms: 30_000 },
    _meta: { "agentexec/group": "a" },
  });
  // Once the command is a session, its group is ended.
  while (alive().length === 0) await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(await stop("a"), { stopped: 1 });
  const { structuredContent } = await waiting;
  assert.deepEqual(
    { ...(structuredContent as object), seconds: 0, text: "" },
    { exit_code: 130, seconds: 0, session_id: null, text: "" },
  );
  assert.ok(Date.now() - began < 10_000);
});

test("a word that isn't one is refused, and starts nothing", async (t) => {
  const { client, alive } = await mounted(t);
  for (const group of [7, "", "x".repeat(201)]) {
    const refused = await client.callTool({
      name: "exec_command",
      arguments: { cmd: "sleep 30" },
      _meta: { "agentexec/group": group },
    });
    assert.deepEqual(
      [refused.isError, refused.content],
      [
        true,
        [{ type: "text", text: "agentexec/group in _meta is a string of 1 to 200 characters." }],
      ],
    );
  }
  assert.deepEqual(alive(), []);
});

test("the request wants a group, and is no tool", async (t) => {
  const { client, stop } = await mounted(t);
  await assert.rejects(stop(""));
  await assert.rejects(client.request({ method: "agentexec/group/stop", params: {} }, Stopped));
  assert.ok(!(await client.listTools()).tools.some((tool) => /group|stop/.test(tool.name)));
});
