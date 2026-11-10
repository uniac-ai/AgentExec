import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { cut, Pending } from "../src/output.ts";
import {
  ExecRefused,
  formatAnswer,
  formatSessions,
  MAX_ENDED,
  MAX_RUNNING,
  Sessions,
} from "../src/sessions.ts";
import { pythonPty } from "./pty.ts";

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

test("the last to end stay listed, and no more of them than that", async (t) => {
  const sessions = new Sessions(realpathSync(tmpdir()));
  t.after(() => sessions.stopAll());
  const long = (await sessions.exec({ cmd: "exec cat", yield_time_ms: 250 })).session_id as string;
  for (let i = 0; i < MAX_ENDED; i++) await sessions.exec({ cmd: `exit ${i}` });
  const before = sessions.list();
  assert.equal(before.length, MAX_ENDED + 1);
  assert.deepEqual(
    before.map((one) => one.exitCode),
    [undefined, ...Array.from({ length: MAX_ENDED }, (_, i) => i)],
  );
  // The oldest to start is the last to end, so it is the first of the others that goes.
  assert.equal((await sessions.write({ session_id: long, chars: "\u0004" })).exit_code, 0);
  const after = sessions.list();
  assert.equal(after.length, MAX_ENDED);
  assert.equal(after[0]?.id, long);
  assert.deepEqual(
    after.slice(1).map((one) => one.id),
    before.slice(2).map((one) => one.id),
  );
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
