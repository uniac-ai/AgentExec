// A host adds tools of its own to AgentExec's.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectHttp } from "./clients.ts";

type Library = typeof import("../src/lib.ts");
type Options = import("../src/lib.ts").AgentExecOptions;
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");
const about = { name: "about", description: "What this place is.", call: () => "a place" };

async function mounted(t: test.TestContext, options: Omit<Options, "workspace">) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const exec = createAgentExec({ workspace, ...options });
  const host = createServer((request, response) => void exec.handle(request, response));
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const { port } = host.address() as AddressInfo;
  const client = await connectHttp(`http://127.0.0.1:${port}/mcp`, "-");
  t.after(async () => {
    await client.close();
    host.close();
    await exec.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  return client;
}

for (const level of ["read", "terminal"] as const)
  test(`at ${level}, a host's tool is offered beside AgentExec's and answers its text`, async (t) => {
    const client = await mounted(t, { level, extraTools: [about] });
    const tools = await client.tools();
    assert.ok(tools.includes("about") && tools.includes("read"));
    assert.equal(tools.includes("exec_command"), level === "terminal");
    assert.deepEqual(await client.call("about", {}), { text: "a place", isError: false });
  });

test("a host's tool that throws is answered as a refusal, with why", async (t) => {
  const call = async () => {
    throw new Error("It is down.");
  };
  const client = await mounted(t, { extraTools: [{ ...about, call }] });
  assert.deepEqual(await client.call("about", {}), { text: "It is down.", isError: true });
});

test("a name AgentExec has, at any level, or one given twice is refused at once", async () => {
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const workspace = tmpdir();
  const edit = { ...about, name: "edit" };
  assert.throws(
    () => createAgentExec({ workspace, level: "read", extraTools: [edit] }),
    /already a tool called edit/,
  );
  assert.throws(
    () => createAgentExec({ workspace, extraTools: [about, about] }),
    /already a tool called about/,
  );
});
