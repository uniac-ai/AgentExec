// What any client of AgentExec can rely on, run against two independent MCP clients and the
// bundled server, as a host runs it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Called, CLIENTS, type McpClient } from "./clients.ts";

interface Answer {
  exit_code: string;
  seconds: number;
  session_id: string;
  text: string;
}
/** An answer's text in its four fixed fields, or a failure if it isn't in that shape. */
function fields({ text, isError }: Called): Answer {
  assert.equal(isError, false, text);
  const match = /^exit_code: (\S+)\nseconds: ([\d.]+)\nsession_id: (\S+)\ntext:\n([\s\S]*)$/.exec(
    text,
  );
  assert.ok(match, `Not the fixed shape: ${text.slice(0, 200)}`);
  return {
    exit_code: match[1] as string,
    seconds: Number(match[2]),
    session_id: match[3] as string,
    text: match[4] as string,
  };
}

for (const [name, connect] of Object.entries(CLIENTS)) {
  const setup = async (t: test.TestContext, level = "terminal") => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
    const client: McpClient = await connect(workspace, level);
    t.after(async () => {
      await client.close();
      rmSync(workspace, { recursive: true, force: true });
    });
    const exec = async (args: Record<string, unknown>) =>
      fields(await client.call("exec_command", args));
    const stdin = async (args: Record<string, unknown>) =>
      fields(await client.call("write_stdin", args));
    return { workspace, client, exec, stdin };
  };

  test(`${name}: a command that ends answers with its exit code, in the workspace`, async (t) => {
    const { exec, workspace } = await setup(t);
    const done = await exec({ cmd: "pwd; echo err >&2" });
    assert.equal(done.exit_code, "0");
    assert.equal(done.session_id, "none");
    assert.equal(done.text, `${workspace}\nerr\n`);
    assert.ok(done.seconds >= 0 && done.seconds < 10);
    assert.equal((await exec({ cmd: "exit 3" })).exit_code, "3");
    mkdirSync(join(workspace, "sub"));
    assert.equal(
      (await exec({ cmd: "pwd", workdir: join(workspace, "sub") })).text,
      `${workspace}/sub\n`,
    );
  });

  test(`${name}: a command outlives its yield, and a poll collects the rest`, async (t) => {
    const { exec, stdin, client } = await setup(t);
    const first = await exec({ cmd: "echo before; sleep 1; echo after", yield_time_ms: 250 });
    assert.equal(first.exit_code, "running");
    assert.match(first.session_id, /^s_/);
    assert.equal(first.text, "before\n");
    const rest = await stdin({ session_id: first.session_id });
    assert.equal(rest.exit_code, "0");
    assert.equal(rest.session_id, "none");
    assert.equal(rest.text, "after\n");
    // It has ended: its session has gone.
    const gone = await client.call("write_stdin", { session_id: first.session_id });
    assert.equal(gone.isError, true);
  });

  test(`${name}: what is typed reaches the command, and Ctrl-D and Ctrl-C work`, async (t) => {
    const { exec, stdin } = await setup(t);
    const cat = await exec({ cmd: "cat", yield_time_ms: 250 });
    assert.equal(
      (await stdin({ session_id: cat.session_id, chars: "hello\n", yield_time_ms: 2000 })).text,
      "hello\n",
    );
    const ended = await stdin({ session_id: cat.session_id, chars: "\u0004", yield_time_ms: 5000 });
    assert.equal(ended.exit_code, "0");

    const sleeping = await exec({ cmd: "sleep 100", yield_time_ms: 250 });
    const stopped = await stdin({
      session_id: sleeping.session_id,
      chars: "\u0003",
      yield_time_ms: 5000,
    });
    assert.equal(stopped.exit_code, "130");
  });

  test(`${name}: long output is cut head and tail`, async (t) => {
    const { exec } = await setup(t);
    const done = await exec({ cmd: "seq 1 200000", max_output_tokens: 100 });
    assert.equal(done.exit_code, "0");
    assert.ok(done.text.startsWith("1\n2\n"));
    assert.ok(done.text.endsWith("199999\n200000\n"));
    assert.match(done.text, /… \d+ characters cut …/);
    assert.ok(done.text.length < 500);
  });

  test(`${name}: two sessions don't collide, and an unknown one is refused`, async (t) => {
    const { exec, stdin, client } = await setup(t);
    const [one, two] = await Promise.all([
      exec({ cmd: "cat", yield_time_ms: 250 }),
      exec({ cmd: "cat", yield_time_ms: 250 }),
    ]);
    assert.notEqual(one.session_id, two.session_id);
    const [a, b] = await Promise.all([
      stdin({ session_id: one.session_id, chars: "first\n", yield_time_ms: 2000 }),
      stdin({ session_id: two.session_id, chars: "second\n", yield_time_ms: 2000 }),
    ]);
    assert.equal(a.text, "first\n");
    assert.equal(b.text, "second\n");
    const unknown = await client.call("write_stdin", { session_id: "s_000000" });
    assert.equal(unknown.isError, true);
    for (const session_id of [one.session_id, two.session_id])
      await stdin({ session_id, chars: "\u0004", yield_time_ms: 5000 });
  });

  for (const [level, tools] of [
    ["read", ["list", "read", "search"]],
    ["files", ["edit", "list", "read", "search"]],
    ["terminal", ["edit", "exec_command", "list", "read", "search", "write_stdin"]],
  ] as const)
    test(`${name}: the ${level} level offers its tools and no others`, async (t) => {
      const { client } = await setup(t, level);
      assert.deepEqual((await client.tools()).sort(), [...tools]);
    });

  test(`${name}: file tools stay inside the workspace, following links`, async (t) => {
    const { client, workspace } = await setup(t, "files");
    const outside = realpathSync(mkdtempSync(`${workspace}-outside-`));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "secret.txt"), "needle\n");
    writeFileSync(join(workspace, "own.txt"), "needle\n");
    mkdirSync(join(workspace, "sub"));
    symlinkSync(join(outside, "secret.txt"), join(workspace, "file-link"));
    symlinkSync(outside, join(workspace, "folder-link"));
    symlinkSync(join(workspace, "own.txt"), join(workspace, "inner-link"));
    symlinkSync(join(outside, "not-yet.txt"), join(workspace, "dangling-link"));

    const blocked = [
      ["read", { path: join(outside, "secret.txt") }],
      ["read", { path: "../" }],
      ["read", { path: "file-link" }],
      ["read", { path: "folder-link/secret.txt" }],
      ["list", { path: outside }],
      ["list", { path: "folder-link" }],
      ["search", { pattern: "needle", path: outside }],
      ["search", { pattern: "needle", path: "folder-link" }],
      ["edit", { path: join(outside, "secret.txt"), old_text: "needle", new_text: "x" }],
      ["edit", { path: "file-link", old_text: "needle", new_text: "x" }],
      ["edit", { path: "folder-link/new.txt", old_text: "", new_text: "x" }],
      ["edit", { path: "dangling-link", old_text: "", new_text: "x" }],
      ["edit", { path: join(outside, "new.txt"), old_text: "", new_text: "x" }],
    ] as const;
    for (const [tool, args] of blocked) {
      const refused = await client.call(tool, args);
      assert.equal(refused.isError, true, `${tool} ${JSON.stringify(args)}: ${refused.text}`);
      assert.match(refused.text, /outside the workspace/);
    }
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "needle\n");
    assert.deepEqual(readdirSync(outside), ["secret.txt"]);

    // Inside is fine, by any name, and a search doesn't follow a link out.
    assert.equal((await client.call("read", { path: "inner-link" })).isError, false);
    assert.equal((await client.call("read", { path: join(workspace, "own.txt") })).isError, false);
    assert.equal((await client.call("read", { path: "sub/../own.txt" })).isError, false);
    assert.equal((await client.call("search", { pattern: "needle" })).text, "own.txt:1:needle");
    const made = await client.call("edit", { path: "sub/new.txt", old_text: "", new_text: "x" });
    assert.equal(made.isError, false, made.text);
  });

  test(`${name}: an edit changes nothing at the read level`, async (t) => {
    const { client, workspace } = await setup(t, "read");
    writeFileSync(join(workspace, "a.txt"), "one\n");
    const attempt = await client
      .call("edit", { path: "a.txt", old_text: "one", new_text: "two" })
      .catch((error: unknown) => ({ text: String(error), isError: true }));
    assert.equal(attempt.isError, true);
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "one\n");
  });

  test(`${name}: an edit replaces exact text and answers with a diff`, async (t) => {
    const { client, workspace } = await setup(t);
    const file = join(workspace, "a.txt");
    writeFileSync(file, "one\ntwo\ntwo\n");
    // A mode the usual umask would cut, were the new file only made with it.
    chmodSync(file, 0o666);
    const done = await client.call("edit", { path: "a.txt", old_text: "one\n", new_text: "ONE\n" });
    assert.equal(done.isError, false);
    assert.match(done.text, /--- a\.txt/);
    assert.match(done.text, /-one\n\+ONE/);
    assert.equal(readFileSync(file, "utf8"), "ONE\ntwo\ntwo\n");
    assert.equal(statSync(file).mode & 0o777, 0o666);

    const twice = await client.call("edit", { path: "a.txt", old_text: "two", new_text: "x" });
    assert.equal(twice.isError, true);
    assert.match(twice.text, /2 times/);
    const absent = await client.call("edit", { path: "a.txt", old_text: "three", new_text: "x" });
    assert.equal(absent.isError, true);
    assert.equal(readFileSync(file, "utf8"), "ONE\ntwo\ntwo\n");

    const all = await client.call("edit", {
      path: "a.txt",
      old_text: "two",
      new_text: "2",
      replace_all: true,
    });
    assert.equal(all.isError, false);
    assert.equal(readFileSync(file, "utf8"), "ONE\n2\n2\n");

    const made = await client.call("edit", { path: "new.txt", old_text: "", new_text: "hi\n" });
    assert.equal(made.isError, false);
    assert.equal(readFileSync(join(workspace, "new.txt"), "utf8"), "hi\n");
    const refused = await client.call("edit", { path: "new.txt", old_text: "", new_text: "more" });
    assert.equal(refused.isError, true);
  });

  test(`${name}: read, list and search`, async (t) => {
    const { client, workspace } = await setup(t);
    writeFileSync(join(workspace, ".gitignore"), "skipped.txt\n");
    writeFileSync(join(workspace, "skipped.txt"), "needle\n");
    writeFileSync(join(workspace, "a.txt"), "l1\nneedle two\nl3\n");
    mkdirSync(join(workspace, "node_modules"));
    writeFileSync(join(workspace, "node_modules", "x.txt"), "needle\n");
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "sub", "b.txt"), "a NEEDLE\n");

    const read = await client.call("read", { path: "a.txt", offset: 2, limit: 1 });
    assert.equal(read.text, "lines 2-2 of 4\n2\tneedle two");
    const missing = await client.call("read", { path: "nope.txt" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No such file/);

    const listed = await client.call("list", {});
    assert.deepEqual(listed.text.split("\n").slice(0, 2), ["node_modules/", "sub/"]);
    assert.ok(listed.text.includes("a.txt\t"));

    assert.equal((await client.call("search", { pattern: "needle" })).text, "a.txt:2:needle two");
    const any = await client.call("search", { pattern: "needle", ignore_case: true });
    assert.deepEqual(any.text.split("\n").sort(), ["a.txt:2:needle two", "sub/b.txt:1:a NEEDLE"]);
    const pattern = await client.call("search", { pattern: "^l\\d$", regex: true });
    assert.deepEqual(pattern.text.split("\n"), ["a.txt:1:l1", "a.txt:3:l3"]);
    // Taken as exact text unless asked: the dot is a dot.
    assert.equal((await client.call("search", { pattern: "l.$" })).text, "");
  });

  test(`${name}: only a file is opened, so a folder and a pipe are refused at once`, async (t) => {
    const { client, workspace } = await setup(t);
    mkdirSync(join(workspace, "sub"));
    execFileSync("mkfifo", [join(workspace, "pipe")]);

    const folder = await client.call("read", { path: "sub" });
    assert.equal(folder.isError, true);
    assert.equal(folder.text, "sub is a folder.");
    const pipe = await client.call("read", { path: "pipe" });
    assert.equal(pipe.isError, true);
    assert.equal(pipe.text, "pipe isn't a file that can be read.");
    writeFileSync(join(workspace, "sub", "data.bin"), new Uint8Array([1, 0, 2]));
    const binary = await client.call("read", { path: "sub/data.bin" });
    assert.equal(binary.isError, true);
    assert.equal(binary.text, "sub/data.bin is a binary file.");

    const edited = await client.call("edit", { path: "pipe", old_text: "a", new_text: "b" });
    assert.equal(edited.isError, true);
    assert.equal(edited.text, "pipe isn't a file that can be read.");
    const onto = await client.call("edit", { path: "sub", old_text: "a", new_text: "b" });
    assert.equal(onto.isError, true);
    assert.equal(onto.text, "sub is a folder.");

    assert.equal((await client.call("search", { pattern: "x", path: "pipe" })).text, "");
    // Nor is a pipe read for a folder's ignore rules.
    execFileSync("mkfifo", [join(workspace, "sub", ".gitignore")]);
    writeFileSync(join(workspace, "sub", "a.txt"), "x marks\n");
    assert.equal((await client.call("search", { pattern: "x" })).text, "sub/a.txt:1:x marks");
  });
}

test("closing the connection stops the commands still running", async (t) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const client = await CLIENTS.typescript(workspace, "terminal");
  const { text } = fields(
    await client.call("exec_command", { cmd: "echo $$; exec sleep 100", yield_time_ms: 250 }),
  );
  const pid = Number(text.trim());
  assert.ok(pid > 0);
  process.kill(pid, 0);
  await client.close();
  for (let i = 0; i < 300; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail("The command outlived the connection.");
});
