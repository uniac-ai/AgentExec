import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cut, Pending } from "../src/output.ts";
import {
  ExecRefused,
  formatAnswer,
  formatSessions,
  listing,
  MAX_ENDED,
  MAX_RUNNING,
  Sessions,
} from "../src/sessions.ts";
import { pythonPty } from "./pty.ts";

// A plain shell and an empty home, so nothing of the user's own profile runs.
process.env.SHELL = "/bin/bash";
process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-home-")));
test.after(() => rmSync(process.env.HOME as string, { recursive: true, force: true }));

test("at the most running, a person's shell among them, a new one is refused and none is evicted", async (t) => {
  const sessions = new Sessions(realpathSync(tmpdir()), undefined, pythonPty().open);
  t.after(() => sessions.stopAll());
  const shell = sessions.open(80, 24);
  const started = await Promise.all(
    Array.from({ length: MAX_RUNNING - 1 }, () =>
      sessions.exec({ cmd: "exec cat", yield_time_ms: 250 }),
    ),
  );
  assert.equal(new Set([shell, ...started.map((one) => one.session_id)]).size, MAX_RUNNING);
  await assert.rejects(sessions.exec({ cmd: "true" }), ExecRefused);
  assert.throws(() => sessions.open(80, 24), ExecRefused);
  const session_id = started[0]?.session_id as string;
  assert.equal(
    (await sessions.write({ session_id, chars: "still here\n", yield_time_ms: 5000 })).text,
    "still here\n",
  );
});

test("so many that ended stay listed, and one nobody has read outlasts those that were read", async (t) => {
  const sessions = new Sessions(realpathSync(tmpdir()));
  t.after(() => sessions.stopAll());
  const start = async (cmd: string) =>
    (await sessions.exec({ cmd, yield_time_ms: 250 })).session_id as string;
  const unread = await start("sleep 0.4; echo built; exit 7");
  const long = await start("exec cat");
  while (sessions.list()[0]?.exitCode === undefined)
    await new Promise((done) => setTimeout(done, 20));
  for (let i = 0; i < MAX_ENDED; i++) await sessions.exec({ cmd: `exit ${i}` });
  // One more has ended than stay, and the first that was read has gone: `exit 0`.
  const before = sessions.list();
  assert.deepEqual(
    before.map((one) => one.exitCode),
    [7, undefined, ...Array.from({ length: MAX_ENDED - 1 }, (_, i) => i + 1)],
  );
  // The one that ends last is not the one that goes.
  const ended = await sessions.write({ session_id: long, chars: "\u0004", yield_time_ms: 5000 });
  assert.equal(ended.exit_code, 0);
  const after = sessions.list();
  assert.deepEqual(
    after.map((one) => one.id),
    [unread, long, ...before.slice(3).map((one) => one.id)],
  );
  // What nobody has read is still there to be read, once.
  const late = await sessions.write({ session_id: unread });
  assert.deepEqual([late.exit_code, late.text], [7, "built\n"]);
  await assert.rejects(sessions.write({ session_id: unread }), ExecRefused);
});

test("what is held between polls keeps its head and tail", () => {
  const pending = new Pending();
  pending.add("a".repeat(800_000));
  pending.add("b".repeat(800_000));
  const text = pending.take();
  assert.ok(text.startsWith("aaa"));
  assert.ok(text.endsWith("bbb"));
  assert.match(text, /… \d+ characters cut …/);
  assert.ok(text.length < 1_100_000);
  assert.equal(pending.take(), "");
});

test("a cut never splits a surrogate pair", () => {
  const text = cut("😀".repeat(100), 11);
  assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.doesNotMatch(text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("an answer's text is its four fields in order", () => {
  assert.equal(
    formatAnswer({ exit_code: null, seconds: 1.5, session_id: "s_1", text: "x" }),
    "exit_code: running\nseconds: 1.5\nsession_id: s_1\ntext:\nx",
  );
});

test("a listed command is its first line, or the start of it", () => {
  const terminal = { id: "s_1", by: "agent" as const, workdir: "/", tty: false, at: "then" };
  const shown = (cmd: string) => listing([{ ...terminal, cmd, output: "" }])[0]?.cmd;
  assert.equal(shown("npm test"), "npm test");
  assert.equal(shown("cat <<EOF\n\nsession_id: s_2\nEOF"), "cat <<EOF…");
  assert.equal(shown("x".repeat(500)), `${"x".repeat(200)}…`);
  assert.equal(shown(`${"x".repeat(199)}😀`), `${"x".repeat(199)}…`);
  assert.deepEqual(listing([{ ...terminal, cmd: "ls", output: "", exitCode: 2, endedAt: "now" }]), [
    { session_id: "s_1", started_by: "agent", since: "then", exit_code: 2, cmd: "ls" },
  ]);
});

test("the list's text is five fields for each session", () => {
  assert.equal(formatSessions([]), "No sessions.");
  const one = { session_id: "s_1", started_by: "agent" as const, since: "then", cmd: "ls" };
  assert.equal(
    formatSessions([
      { ...one, exit_code: null },
      { ...one, session_id: "s_2", started_by: "person", exit_code: 2 },
    ]),
    "session_id: s_1\nstarted_by: agent\nsince: then\nexit_code: running\ncmd: ls\n\n" +
      "session_id: s_2\nstarted_by: person\nsince: then\nexit_code: 2\ncmd: ls",
  );
});
