// The file tools reach the workspace, or the whole machine with relative paths from the workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Library = typeof import("../src/lib.ts");
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const LIBRARY = join(DIST, "lib.js");

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
  return { workspace, beside, call, files: exec.files };
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

test("at machine, paths go anywhere and relative ones start at the workspace", async (t) => {
  const { workspace, beside, call, files } = await mounted(t, "machine");
  const there = join(beside, "there.txt");
  assert.match((await call("read", { path: there })).text, /^1\tthere$/m);
  assert.match((await call("read", { path: "here.txt" })).text, /^1\there$/m);
  assert.match((await call("list", { path: beside })).text, /there\.txt/);
  // A file outside the workspace is named by its whole path, one inside it from the workspace.
  assert.ok(
    (await call("search", { pattern: "there", path: beside })).text
      .split("\n")
      .includes(`${there}:1:there`),
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
  // The host's own files stay inside the workspace.
  await assert.rejects(files.list(beside), /is outside the workspace/);
});

test("at machine, an edit through a link changes what it points to", async (t) => {
  const { beside, call } = await mounted(t, "machine");
  const link = join(beside, "link.txt");
  symlinkSync(join(beside, "there.txt"), link);
  assert.equal(
    (await call("edit", { path: link, old_text: "there", new_text: "changed" })).isError,
    false,
  );
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(join(beside, "there.txt"), "utf8"), "changed\n");
  const nowhere = join(beside, "nowhere.txt");
  symlinkSync(join(beside, "missing.txt"), nowhere);
  assert.deepEqual(await call("edit", { path: nowhere, old_text: "", new_text: "x" }), {
    text: `${nowhere} is a link to nothing.`,
    isError: true,
  });
});

test("search names a folder that starts with two dots from the workspace", async (t) => {
  const { workspace, call } = await mounted(t);
  mkdirSync(join(workspace, "..dots"));
  writeFileSync(join(workspace, "..dots", "a.txt"), "dotted\n");
  assert.match((await call("search", { pattern: "dotted" })).text, /^\.\.dots\/a\.txt:1:/m);
});

test("--reach takes only workspace or machine", async (t) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-reach-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    join(DIST, "agentexec.js"),
    "--workspace",
    workspace,
    "--reach",
    "everywhere",
  ]);
  let said = "";
  child.stderr.on("data", (chunk) => {
    said += chunk;
  });
  const [code] = (await once(child, "exit")) as [number];
  assert.equal(code, 1);
  assert.match(said, /--reach is workspace or machine\./);
});
