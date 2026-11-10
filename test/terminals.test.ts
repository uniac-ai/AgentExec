// One list of terminals for the agent and a person: each sees, types into and stops the other's.
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
import { pythonPty } from "./pty.ts";

type Library = typeof import("../src/lib.ts");
type Options = import("../src/lib.ts").AgentExecOptions;
type CommandEvent = import("../src/lib.ts").CommandEvent;
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");

// A plain shell and an empty home, so nothing of the user's own profile runs.
process.env.SHELL = "/bin/bash";
process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-home-")));
test.after(() => rmSync(process.env.HOME as string, { recursive: true, force: true }));

async function mounted(t: test.TestContext, options: Partial<Options> = {}) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const exec = createAgentExec({ workspace, level: "terminal", ...options });
  const events: CommandEvent[] = [];
  exec.onCommand((event) => events.push(event));
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
  /** What one terminal has written, as a listener heard it. */
  const written = (id: string) =>
    events.map((e) => (e.type === "output" && e.id === id ? e.text : "")).join("");
  const exited = (id: string) => events.find((e) => e.type === "exit" && e.id === id);
  return { exec, client, workspace, events, written, exited };
}

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 20));
  }
};
const sessionOf = (text: string) => /session_id: (\S+)/.exec(text)?.[1] as string;
/** `list_sessions`' text as one record for each session. */
const listed = (text: string) =>
  text
    .split("\n\n")
    .map((block) => Object.fromEntries(block.split("\n").map((l) => l.split(": "))));

test("every command is listed, running and ended, for a call that didn't start it", async (t) => {
  const { exec, client, workspace } = await mounted(t);
  assert.equal((await client.call("list_sessions", {})).text, "No sessions.");
  const cat = sessionOf(
    (await client.call("exec_command", { cmd: "cat", yield_time_ms: 250 })).text,
  );
  await client.call("exec_command", { cmd: "echo quick; exit 3" });

  const sessions = listed((await client.call("list_sessions", {})).text);
  assert.deepEqual(
    sessions.map(({ since, ...rest }) => rest),
    [
      { session_id: cat, started_by: "agent", exit_code: "running", cmd: "cat" },
      {
        session_id: sessions[1]?.session_id,
        started_by: "agent",
        exit_code: "3",
        cmd: "echo quick; exit 3",
      },
    ],
  );
  assert.ok(sessions.every((one) => !Number.isNaN(Date.parse(one.since))));
  // The one that ended in its first answer is listed, and no longer answers.
  const quick = sessions[1]?.session_id as string;
  assert.match(quick, /^s_/);
  assert.equal((await client.call("write_stdin", { session_id: quick })).isError, true);

  const [first, second] = exec.terminals.list();
  assert.deepEqual(
    { ...first, at: "" },
    { id: cat, by: "agent", cmd: "cat", workdir: workspace, tty: false, at: "", output: "" },
  );
  assert.deepEqual(
    { id: second?.id, output: second?.output, exitCode: second?.exitCode },
    { id: quick, output: "quick\n", exitCode: 3 },
  );
  assert.ok(!Number.isNaN(Date.parse(second?.endedAt as string)));
});

test("a person's shell is a terminal the agent finds, reads and types into", async (t) => {
  const pty = pythonPty();
  const { exec, client, workspace, events, written, exited } = await mounted(t, { pty: pty.open });
  const id = exec.terminals.open({ columns: 100, rows: 30 });
  assert.deepEqual(pty.sizes, [[100, 30]]);
  assert.deepEqual(
    events.find((e) => e.type === "start"),
    {
      type: "start",
      id,
      by: "person",
      cmd: "/bin/bash",
      workdir: workspace,
      tty: true,
      at: (events[0] as { at: string }).at,
    },
  );

  // It is on a terminal device, in the workspace.
  exec.terminals.write(id, "tty; pwd\n");
  await until(() => /\/dev\/\S+/.test(written(id)), "the terminal's name");
  await until(() => written(id).includes(workspace), "the workspace");
  assert.ok(events.every((e) => e.type !== "output" || e.stream === undefined));

  // The agent finds it without having started it, types into it, and reads what it wrote.
  const sessions = listed((await client.call("list_sessions", {})).text);
  assert.deepEqual(
    sessions.map(({ since, ...rest }) => rest),
    [{ session_id: id, started_by: "person", exit_code: "running", cmd: "/bin/bash" }],
  );
  const typed = await client.call("write_stdin", {
    session_id: id,
    chars: "echo $((6 * 7))-from-the-agent\n",
    yield_time_ms: 2000,
  });
  assert.match(typed.text, /^exit_code: running\n/);
  assert.match(typed.text, /42-from-the-agent/);
  assert.match(typed.text, /\/dev\/\S+/, "what the person ran before is the agent's to read");
  // And the person sees what the agent ran.
  await until(() => written(id).includes("42-from-the-agent"), "the agent's command");
  assert.ok(exec.terminals.list()[0]?.output.includes("42-from-the-agent"));

  exec.terminals.resize(id, 120, 40);
  assert.deepEqual(pty.sizes.at(-1), [120, 40]);

  await exec.terminals.stop(id);
  await until(() => exited(id) !== undefined, "the shell's end");
  const ended = exec.terminals.list()[0];
  assert.equal(ended?.exitCode, 129);
  assert.throws(() => exec.terminals.write(id, "more\n"), /has ended/);
  // Its end is the agent's to read once, like any command's.
  assert.match((await client.call("write_stdin", { session_id: id })).text, /^exit_code: 129\n/);
  assert.equal((await client.call("write_stdin", { session_id: id })).isError, true);
});

test("a person types into the agent's command, and stops one", async (t) => {
  const { exec, client, exited } = await mounted(t);
  const cat = sessionOf(
    (await client.call("exec_command", { cmd: "cat", yield_time_ms: 250 })).text,
  );
  exec.terminals.write(cat, "from a person\n");
  const read = await client.call("write_stdin", { session_id: cat });
  assert.match(read.text, /^exit_code: running\n[\s\S]*text:\nfrom a person\n$/);
  exec.terminals.write(cat, "\u0004");
  await until(() => exited(cat) !== undefined, "the end of its input");
  assert.equal(exec.terminals.list()[0]?.exitCode, 0);

  const sleep = sessionOf(
    (await client.call("exec_command", { cmd: "sleep 100", yield_time_ms: 250 })).text,
  );
  await exec.terminals.stop(sleep);
  assert.equal(exec.terminals.list()[1]?.exitCode, 130);
  await exec.terminals.stop(sleep);

  // One that ignores the interrupt is killed.
  const deaf = sessionOf(
    (await client.call("exec_command", { cmd: "trap '' INT; sleep 100", yield_time_ms: 250 })).text,
  );
  await exec.terminals.stop(deaf);
  await until(() => exited(deaf) !== undefined, "the kill");
  assert.equal(exec.terminals.list()[2]?.exitCode, 137);
});

test("a terminal can be acted on from the moment it is heard starting", async (t) => {
  const pty = pythonPty();
  const { exec, written } = await mounted(t, { pty: pty.open });
  exec.onCommand((event) => {
    if (event.type !== "start") return;
    exec.terminals.resize(event.id, 132, 50);
    exec.terminals.write(event.id, "echo typed-$((1 + 1))-at-once\n");
  });
  const id = exec.terminals.open({ columns: 80, rows: 24 });
  assert.deepEqual(pty.sizes, [
    [80, 24],
    [132, 50],
  ]);
  await until(() => written(id).includes("typed-2-at-once"), "what was typed at its start");
});

test("a terminal keeps the end of what it wrote", async (t) => {
  const { exec, client } = await mounted(t);
  await client.call("exec_command", { cmd: "seq 1 30000" });
  const output = exec.terminals.list()[0]?.output as string;
  assert.equal(output.length, 65_536);
  assert.ok(output.endsWith("\n29999\n30000\n"));
});

test("what can't be done says why", async (t) => {
  const pty = pythonPty();
  const plain = await mounted(t);
  assert.throws(() => plain.exec.terminals.open({ columns: 80, rows: 24 }), /terminal device/);
  const files = await mounted(t, { level: "files", pty: pty.open });
  assert.throws(() => files.exec.terminals.open({ columns: 80, rows: 24 }), /terminal level/);

  const none = await mounted(t, {
    pty() {
      throw new Error("no terminal devices are left");
    },
  });
  assert.throws(
    () => none.exec.terminals.open({ columns: 80, rows: 24 }),
    /The shell didn't start: no terminal devices are left/,
  );
  assert.deepEqual(none.exec.terminals.list(), []);

  const { exec, client } = await mounted(t, { pty: pty.open });
  for (const [columns, rows] of [
    [0, 24],
    [80, 1001],
    [80.5, 24],
  ] as const)
    assert.throws(() => exec.terminals.open({ columns, rows }), /1 to 1000 columns and rows/);
  assert.deepEqual(pty.sizes, []);
  assert.deepEqual(exec.terminals.list(), []);

  const cat = sessionOf(
    (await client.call("exec_command", { cmd: "cat", yield_time_ms: 250 })).text,
  );
  assert.throws(() => exec.terminals.resize(cat, 80, 24), /Only a shell/);
  for (const act of [
    () => exec.terminals.write("s_none", "x"),
    () => exec.terminals.resize("s_none", 80, 24),
  ])
    assert.throws(act, /No terminal s_none is here/);
  await assert.rejects(exec.terminals.stop("s_none"), /No terminal s_none is here/);
});
