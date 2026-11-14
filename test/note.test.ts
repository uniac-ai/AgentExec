// A host's line, added to a tool's answer: asked before the tool runs, with its name and input.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

type Library = typeof import("../src/lib.ts");
type Options = Partial<Parameters<Library["createAgentExec"]>[0]>;
interface Answer {
  content: { type: string; text?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");
// The smallest PNG there is: one pixel.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A workspace with a text file and a picture. */
function space(t: test.TestContext) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-note-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "a.txt"), "a\n");
  writeFileSync(join(workspace, "dot.png"), PNG);
  return workspace;
}

/** A workspace's tools served with `options`, and a caller. */
async function mounted(t: test.TestContext, options: Options = {}, workspace = space(t)) {
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const exec = createAgentExec({ workspace, level: "terminal", ...options });
  const host = createServer((request, response) => void exec.handle(request, response));
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const client = new Client({ name: "note", version: "1" });
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
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as Answer;
}

const noted = (tool: string) => ({ type: "text", text: `noted ${tool}` });
/** An answer without how long its command took, which differs from call to call. */
const timeless = (answer: Answer): Answer => ({
  ...answer,
  content: answer.content.map((one) =>
    one.text ? { ...one, text: one.text.replace(/^seconds: [\d.]+$/m, "seconds: 0") } : one,
  ),
  ...(answer.structuredContent
    ? { structuredContent: { ...answer.structuredContent, seconds: 0 } }
    : {}),
});

test("the line comes after the answer, and the answer is otherwise as it was", async (t) => {
  const workspace = space(t);
  const plain = await mounted(t, {}, workspace);
  const call = await mounted(t, { note: (tool) => `noted ${tool}` }, workspace);
  for (const [tool, args] of [
    ["read", { path: "a.txt" }],
    ["read", { path: "dot.png" }],
    ["read", { path: "missing.txt" }],
    ["exec_command", { cmd: "echo hi" }],
  ] as const) {
    const [before, after] = [await plain(tool, args), await call(tool, args)].map(timeless);
    assert.deepEqual(
      after?.content,
      [...(before?.content ?? []), noted(tool)],
      JSON.stringify(args),
    );
    assert.equal(after?.isError, before?.isError);
    assert.deepEqual(after?.structuredContent, before?.structuredContent);
  }
});

test("it is asked before the tool runs, with its input, or nothing for a tool that takes none", async (t) => {
  const asked: string[] = [];
  const call = await mounted(t, {
    extraTools: [
      {
        name: "about",
        description: "What this is.",
        call: () => {
          asked.push("about ran");
          return "here";
        },
      },
    ],
    note: (tool, input) => {
      asked.push(`${tool} ${JSON.stringify(input)}`);
      return undefined;
    },
  });
  await call("read", { path: "a.txt" });
  await call("about");
  assert.deepEqual(asked, ['read {"path":"a.txt"}', "about {}", "about ran"]);
});

test("a note that gives nothing, throws or changes the input changes nothing", async (t) => {
  for (const note of [
    () => undefined,
    () => {
      throw new Error("No.");
    },
    (_: string, input: Record<string, unknown>) => {
      input.path = "missing.txt";
      return undefined;
    },
  ]) {
    const read = await (await mounted(t, { note }))("read", { path: "a.txt" });
    assert.equal(read.content.length, 1);
    assert.match(read.content[0]?.text ?? "", /^1\ta$/m);
  }
});
