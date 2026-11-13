// The file tools reach the workspace, or the whole machine with relative paths from the workspace.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Library = typeof import("../src/lib.ts");
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");

/** A workspace, a folder beside it with a file in it, and the file tools at `reach`. */
async function mounted(t: test.TestContext, reach?: "workspace" | "machine") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-reach-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const beside = join(root, "beside");
  mkdirSync(workspace);
  mkdirSync(beside);
  writeFileSync(join(workspace, "here.txt"), "here\n");
  writeFileSync(join(beside, "there.txt"), "there\n");
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const exec = createAgentExec({ workspace, level: "files", ...(reach ? { reach } : {}) });
  const host = createServer((request, response) => void exec.handle(request, response));
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const client = new Client({ name: "reach", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(host.address() as AddressInfo).port}/mcp`),
    ),
  );
  t.after(async () => {
    await client.close();
    host.close();
    await exec.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const { content, isError } = (await client.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: content.map((block) => block.text ?? "").join(""), isError: !!isError };
  };
  return { workspace, beside, call };
}

test("by default the file tools stay inside the workspace", async (t) => {
  const { beside, call } = await mounted(t);
  const there = join(beside, "there.txt");
  for (const [name, args] of [
    ["read", { path: there }],
    ["list", { path: beside }],
    ["search", { pattern: "there", path: beside }],
    ["edit", { path: join(beside, "new.txt"), old_text: "", new_text: "x" }],
  ] as const) {
    const answer = await call(name, args);
    assert.deepEqual(
      answer,
      { text: `${args.path} is outside the workspace.`, isError: true },
      name,
    );
  }
  assert.match((await call("read", { path: "here.txt" })).text, /here/);
});

test("reaching the whole machine, they go anywhere, and relative paths start at the workspace", async (t) => {
  const { workspace, beside, call } = await mounted(t, "machine");
  const there = join(beside, "there.txt");
  assert.match((await call("read", { path: there })).text, /^1\tthere$/m);
  assert.match((await call("read", { path: "here.txt" })).text, /^1\there$/m);
  assert.match((await call("list", { path: beside })).text, /there\.txt/);
  // A file outside the workspace is named by its whole path, one inside it from the workspace.
  assert.match(
    (await call("search", { pattern: "there", path: beside })).text,
    new RegExp(`^${there}:1:`, "m"),
  );
  assert.match((await call("search", { pattern: "here" })).text, /^here\.txt:1:/m);
  const made = join(beside, "new.txt");
  assert.equal(
    (await call("edit", { path: made, old_text: "", new_text: "made\n" })).isError,
    false,
  );
  assert.equal(readFileSync(made, "utf8"), "made\n");
  assert.equal(
    (await call("edit", { path: "new.txt", old_text: "", new_text: "in\n" })).isError,
    false,
  );
  assert.equal(readFileSync(join(workspace, "new.txt"), "utf8"), "in\n");
});
