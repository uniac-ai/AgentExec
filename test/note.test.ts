// A host's line, added to a tool's answer: asked as the call begins, with the tool and its input.
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
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");

async function mounted(
  t: test.TestContext,
  options: Partial<Parameters<Library["createAgentExec"]>[0]>,
) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-note-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "a.txt"), "a\n");
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
    (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      structuredContent?: Record<string, unknown>;
    };
}

test("a host's line ends each answer, asked as the call begins, with the tool and its input", async (t) => {
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
      return tool === "list" ? undefined : `noted ${tool}`;
    },
  });
  const read = await call("read", { path: "a.txt" });
  assert.deepEqual(read.content.at(-1), { type: "text", text: "noted read" });
  assert.match(read.content[0]?.text ?? "", /^1\ta$/m);
  // The answer's own structure is as it was, with the line only in its text.
  const ran = await call("exec_command", { cmd: "echo hi" });
  assert.deepEqual(ran.content.at(-1), { type: "text", text: "noted exec_command" });
  assert.equal(ran.structuredContent?.exit_code, 0);
  // Nothing given, nothing added.
  assert.equal((await call("list")).content.length, 1);
  // A tool that takes nothing, a host's own among them, is asked about with nothing; and the note
  // comes before the tool runs.
  assert.deepEqual((await call("about")).content.at(-1), { type: "text", text: "noted about" });
  assert.deepEqual(asked, [
    'read {"path":"a.txt"}',
    'exec_command {"cmd":"echo hi"}',
    "list {}",
    "about {}",
    "about ran",
  ]);
});

test("a note that throws adds nothing, and the call is answered", async (t) => {
  const call = await mounted(t, {
    note: () => {
      throw new Error("No.");
    },
  });
  const read = await call("read", { path: "a.txt" });
  assert.equal(read.content.length, 1);
  assert.match(read.content[0]?.text ?? "", /^1\ta$/m);
});
