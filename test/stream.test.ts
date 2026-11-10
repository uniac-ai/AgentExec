// A host hears each command as it runs, while the agent's answers stay as they were.
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
type CommandEvent = import("../src/lib.ts").CommandEvent;
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");

async function mounted(t: test.TestContext) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const exec = createAgentExec({ workspace, level: "terminal" });
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
  return { exec, client, workspace };
}

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 20));
  }
};
const sessionOf = (text: string) => /session_id: (\S+)/.exec(text)?.[1] as string;

test("output arrives as it's written, with no one polling, and the agent still gets all of it", async (t) => {
  const { exec, client, workspace } = await mounted(t);
  const events: CommandEvent[] = [];
  exec.onCommand((event) => events.push(event));
  const answer = await client.call("exec_command", {
    cmd: "echo first; sleep 1; echo second; echo oops >&2; exit 3",
    yield_time_ms: 250,
  });
  const id = sessionOf(answer.text);
  assert.match(answer.text, /exit_code: running/);
  assert.match(answer.text, /text:\nfirst\n$/);

  // Nothing asks for more, and the rest still arrives.
  await until(() => events.some((e) => e.type === "exit"), "the exit");
  const [start, ...rest] = events;
  assert.deepEqual(
    { type: start?.type, id: start?.id, workdir: start?.type === "start" && start.workdir },
    { type: "start", id, workdir: workspace },
  );
  assert.equal(
    start?.type === "start" && start.cmd,
    "echo first; sleep 1; echo second; echo oops >&2; exit 3",
  );
  const written = (stream: string) =>
    rest
      .filter((e) => e.type === "output" && e.stream === stream)
      .map((e) => (e.type === "output" ? e.text : ""))
      .join("");
  assert.equal(written("stdout"), "first\nsecond\n");
  assert.equal(written("stderr"), "oops\n");
  assert.deepEqual(
    rest.at(-1) && {
      type: rest.at(-1)?.type,
      id: rest.at(-1)?.id,
      exitCode: (rest.at(-1) as { exitCode?: number }).exitCode,
    },
    { type: "exit", id, exitCode: 3 },
  );
  assert.ok(rest.every((e) => e.id === id));

  const polled = await client.call("write_stdin", { session_id: id });
  assert.match(polled.text, /^exit_code: 3\n/);
  assert.match(polled.text, /second\n/);
  assert.match(polled.text, /oops\n/);
});

test("each command is told apart, a listener can stop, and one that fails harms nothing", async (t) => {
  const { exec, client } = await mounted(t);
  const heard: CommandEvent[] = [];
  const stop = exec.onCommand((event) => heard.push(event));
  exec.onCommand(() => {
    throw new Error("a listener that fails");
  });
  const one = sessionOf(
    (await client.call("exec_command", { cmd: "cat", yield_time_ms: 250 })).text,
  );
  const two = await client.call("exec_command", { cmd: "echo two" });
  assert.match(two.text, /^exit_code: 0\n[\s\S]*text:\ntwo\n$/);
  await client.call("write_stdin", { session_id: one, chars: "typed\n", yield_time_ms: 500 });
  await until(() => heard.some((e) => e.type === "output" && e.id === one), "the echoed input");
  assert.ok(heard.some((e) => e.type === "exit" && e.id !== one && e.exitCode === 0));
  const before = heard.length;
  stop();
  await client.call("write_stdin", { session_id: one, chars: "\u0004", yield_time_ms: 2000 });
  await client.call("exec_command", { cmd: "echo three" });
  assert.equal(heard.length, before);
});

test("a command that can't start is heard ending", async (t) => {
  const { exec, client } = await mounted(t);
  const events: CommandEvent[] = [];
  exec.onCommand((event) => events.push(event));
  const answer = await client.call("exec_command", { cmd: "true", workdir: "/nonexistent-folder" });
  assert.match(answer.text, /^exit_code: 127\n/);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "output", "exit"],
  );
});
