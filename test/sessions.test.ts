import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { cut, Pending } from "../src/output.ts";
import { ExecRefused, formatAnswer, MAX_RUNNING, Sessions } from "../src/sessions.ts";

test("at the most commands running, a new one is refused and none is evicted", async (t) => {
  const sessions = new Sessions(realpathSync(tmpdir()));
  t.after(() => sessions.stopAll());
  const started = await Promise.all(
    Array.from({ length: MAX_RUNNING }, () =>
      sessions.exec({ cmd: "exec cat", yield_time_ms: 250 }),
    ),
  );
  assert.equal(new Set(started.map((one) => one.session_id)).size, MAX_RUNNING);
  await assert.rejects(sessions.exec({ cmd: "true" }), ExecRefused);
  const session_id = started[0]?.session_id as string;
  assert.equal((await sessions.write({ session_id, chars: "still here\n" })).text, "still here\n");
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
