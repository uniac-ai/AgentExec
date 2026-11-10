// The workspace's files for the host itself: listed with dates, read as bytes, written whole, and
// found by when they changed, all kept inside the workspace as the tools are.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Library = typeof import("../src/lib.ts");
const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lib.js");

async function mounted(t: test.TestContext, level: "read" | "files" | "terminal" = "files") {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agentexec-outside-")));
  const { createAgentExec } = (await import(LIBRARY)) as Library;
  const exec = createAgentExec({ workspace, level });
  t.after(async () => {
    await exec.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const put = (path: string, content: string | Uint8Array, modified?: Date) => {
    const file = join(workspace, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (modified) utimesSync(file, modified, modified);
  };
  return { files: exec.files, exec, workspace, outside, put };
}

const OLD = new Date("2020-01-01T00:00:00.000Z");
const NEW = new Date("2030-01-01T00:00:00.000Z");
const temporaries = (folder: string) =>
  readdirSync(folder).filter((name) => name.startsWith(".agentexec-"));

test("a folder is listed with each entry's kind, size and date, folders first", async (t) => {
  const { files, workspace, put } = await mounted(t);
  put("b.txt", "four", OLD);
  put("a.bin", new Uint8Array([0, 1, 2]), NEW);
  put("docs/inner.md", "x");
  symlinkSync(join(workspace, "b.txt"), join(workspace, "link"));

  const { entries, more } = await files.list();
  assert.equal(more, false);
  assert.deepEqual(
    entries.map(({ name, kind }) => [name, kind]),
    [
      ["docs", "folder"],
      ["a.bin", "file"],
      ["b.txt", "file"],
      ["link", "link"],
    ],
  );
  const named = (name: string) => entries.find((entry) => entry.name === name);
  assert.equal(named("a.bin")?.size, 3);
  assert.equal(named("a.bin")?.modifiedAt, NEW.toISOString());
  assert.equal(named("b.txt")?.size, 4);
  assert.equal(named("b.txt")?.modifiedAt, OLD.toISOString());

  assert.deepEqual(
    (await files.list("docs")).entries.map((entry) => entry.name),
    ["inner.md"],
  );
  await assert.rejects(files.list("b.txt"), /isn't a folder/);
  await assert.rejects(files.list("missing"), /No such file or folder/);
});

test("a folder with more than a thousand entries gives the first thousand and says so", async (t) => {
  const { files, put } = await mounted(t);
  for (let i = 0; i < 1001; i++) put(`f${String(i).padStart(4, "0")}`, "");
  const { entries, more } = await files.list();
  assert.equal(entries.length, 1000);
  assert.equal(entries[0]?.name, "f0000");
  assert.equal(more, true);
});

test("a file is read as bytes, a range at a time, whatever is in it", async (t) => {
  const { files, put } = await mounted(t);
  const content = Uint8Array.from({ length: 10 }, (_, i) => (i === 3 ? 0 : i + 65));
  put("data.bin", content, OLD);

  const first = await files.read("data.bin", 0, 4);
  assert.deepEqual([...first.bytes], [...content.subarray(0, 4)]);
  assert.equal(first.size, 10);
  assert.equal(first.modifiedAt, OLD.toISOString());

  assert.deepEqual([...(await files.read("data.bin", 8, 100)).bytes], [...content.subarray(8)]);
  assert.equal((await files.read("data.bin", 10, 5)).bytes.length, 0);
  assert.equal((await files.read("data.bin", 500, 5)).bytes.length, 0);

  put("docs/x", "");
  await assert.rejects(files.read("docs", 0, 1), /is a folder/);
  await assert.rejects(files.read("missing", 0, 1), /No such file or folder/);
  for (const [offset, length] of [
    [-1, 1],
    [0, 0],
    [0, 1024 * 1024 + 1],
    [0.5, 1],
  ] as const)
    await assert.rejects(files.read("data.bin", offset, length), /A read starts at 0 or later/);
  assert.equal((await files.read("data.bin", 0, 1024 * 1024)).bytes.length, 10);
});

test("nothing outside the workspace is listed, read or written, by a path or through a link", async (t) => {
  const { files, workspace, outside } = await mounted(t);
  writeFileSync(join(outside, "secret"), "no");
  symlinkSync(outside, join(workspace, "out"));
  symlinkSync(join(outside, "secret"), join(workspace, "leak"));

  for (const path of ["..", outside, "out"])
    await assert.rejects(files.list(path), /outside the workspace/);
  for (const path of ["../x", join(outside, "secret"), "out/secret", "leak"]) {
    await assert.rejects(files.read(path, 0, 1), /outside the workspace/);
    await assert.rejects(files.upload(path), /outside the workspace/);
  }
  assert.equal(readFileSync(join(outside, "secret"), "utf8"), "no");
  assert.deepEqual(readdirSync(outside), ["secret"]);
});

test("the files that changed after a time are found wherever they are, the newest first", async (t) => {
  const { files, put } = await mounted(t);
  put("old.txt", "x", OLD);
  put("new.txt", "12345", NEW);
  put("deep/er/newer.txt", "x", new Date(NEW.getTime() + 1000));
  put(".gitignore", "ignored/\n*.log\n", OLD);
  put("ignored/new.txt", "x", NEW);
  put("run.log", "x", NEW);
  put("node_modules/pkg/index.js", "x", NEW);
  put(".git/HEAD", "x", NEW);

  const { changes, more } = await files.changed(new Date("2025-01-01T00:00:00.000Z"));
  assert.equal(more, false);
  assert.deepEqual(changes, [
    {
      path: "deep/er/newer.txt",
      size: 1,
      modifiedAt: new Date(NEW.getTime() + 1000).toISOString(),
    },
    { path: "new.txt", size: 5, modifiedAt: NEW.toISOString() },
  ]);
  assert.deepEqual((await files.changed(new Date(NEW.getTime() + 5000))).changes, []);
  assert.deepEqual((await files.changed(new Date(0))).changes.map((change) => change.path).sort(), [
    ".gitignore",
    "deep/er/newer.txt",
    "new.txt",
    "old.txt",
  ]);
  await assert.rejects(files.changed(new Date("not a time")), /isn't a time/);
});

test("more than a thousand changed files gives a thousand and says so", async (t) => {
  const { files, put } = await mounted(t);
  for (let i = 0; i < 1001; i++) put(`many/f${i}`, "", NEW);
  const { changes, more } = await files.changed(OLD);
  assert.equal(changes.length, 1000);
  assert.equal(more, true);
});

test("an upload is in place only once it is finished, whole, and keeps the mode of what it replaces", async (t) => {
  const { files, workspace, put } = await mounted(t);
  put("tool.sh", "before");
  chmodSync(join(workspace, "tool.sh"), 0o750);

  const upload = await files.upload("tool.sh");
  await upload.write(new Uint8Array([0, 255, 1]));
  await upload.write(new TextEncoder().encode("rest"));
  assert.equal(readFileSync(join(workspace, "tool.sh"), "utf8"), "before");
  const done = await upload.finish();
  assert.equal(done.size, 7);
  assert.equal(done.modifiedAt, statSync(join(workspace, "tool.sh")).mtime.toISOString());
  assert.deepEqual(
    [...readFileSync(join(workspace, "tool.sh"))],
    [0, 255, 1, ...new TextEncoder().encode("rest")],
  );
  assert.equal(statSync(join(workspace, "tool.sh")).mode & 0o777, 0o750);
  assert.deepEqual(temporaries(workspace), []);
  await assert.rejects(upload.write(new Uint8Array(1)), /has ended/);
  await assert.rejects(upload.finish(), /has ended/);

  mkdirSync(join(workspace, "sub"));
  const fresh = await files.upload("sub/new.txt");
  await fresh.write(new TextEncoder().encode("hello"));
  await fresh.finish();
  assert.equal(readFileSync(join(workspace, "sub", "new.txt"), "utf8"), "hello");

  const empty = await files.upload("empty");
  assert.equal((await empty.finish()).size, 0);
});

test("an upload given up, or left open when the host closes, leaves what was there", async (t) => {
  const { files, exec, workspace, put } = await mounted(t);
  put("keep.txt", "kept");
  const given = await files.upload("keep.txt");
  await given.write(new Uint8Array(8));
  await given.abort();
  await given.abort();
  assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "kept");
  assert.deepEqual(temporaries(workspace), []);

  const left = await files.upload("never.txt");
  await left.write(new Uint8Array(8));
  assert.equal(temporaries(workspace).length, 1);
  await exec.close();
  assert.equal(existsSync(join(workspace, "never.txt")), false);
  assert.deepEqual(temporaries(workspace), []);
  await assert.rejects(left.finish(), /has ended/);
});

test("an upload is refused onto a folder, into a folder that isn't there, and at the read level", async (t) => {
  const { files, workspace } = await mounted(t);
  mkdirSync(join(workspace, "sub"));
  await assert.rejects(files.upload("sub"), /is a folder/);
  await assert.rejects(files.upload("nowhere/new.txt"), /No such file or folder/);
  assert.deepEqual(readdirSync(workspace), ["sub"]);

  const reading = await mounted(t, "read");
  reading.put("a.txt", "a");
  await assert.rejects(reading.files.upload("b.txt"), /can be read, not written/);
  assert.equal((await reading.files.list()).entries.length, 1);
  assert.equal((await reading.files.read("a.txt", 0, 5)).bytes.length, 1);
  assert.equal((await reading.files.changed(OLD)).changes.length, 1);
});
