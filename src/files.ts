// Reading, listing and editing files. An edit replaces exact text and answers with a diff.
import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { cut } from "./output.ts";
import { ExecRefused } from "./sessions.ts";

const DEFAULT_LINES = 2_000;
const MAX_READ_CHARS = 28_000;
const MAX_LINE_CHARS = 2_000;
const MAX_ENTRIES = 1_000;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;

const reason = (error: unknown) => {
  const { code, path } = error as NodeJS.ErrnoException;
  if (code === "ENOENT") return `No such file or folder: ${path}`;
  if (code === "EISDIR") return `${path} is a folder.`;
  if (code === "ENOTDIR") return `${path} isn't a folder.`;
  if (code === "EACCES" || code === "EPERM") return `Not allowed: ${path}`;
  return error instanceof Error ? error.message : String(error);
};
const refusing = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ExecRefused) throw error;
    throw new ExecRefused(reason(error));
  }
};

export function createFiles(root: string) {
  const at = (path: string) => resolve(root, path);
  const text = async (path: string) => {
    const bytes = await readFile(path);
    if (bytes.includes(0)) throw new ExecRefused(`${path} is a binary file.`);
    return bytes.toString("utf8");
  };

  return {
    /** Numbered lines of a file. */
    read: (input: { path: string; offset?: number | undefined; limit?: number | undefined }) =>
      refusing(async () => {
        const lines = (await text(at(input.path))).split("\n");
        const first = Math.max(input.offset ?? 1, 1);
        const shown = lines
          .slice(first - 1, first - 1 + (input.limit ?? DEFAULT_LINES))
          .map((line, i) => `${first + i}\t${cut(line, MAX_LINE_CHARS)}`);
        const last = first + shown.length - 1;
        return `lines ${first}-${last} of ${lines.length}\n${cut(shown.join("\n"), MAX_READ_CHARS)}`;
      }),

    /** A folder's entries, folders first, each folder ending in `/`. */
    list: (input: { path?: string | undefined }) =>
      refusing(async () => {
        const folder = at(input.path ?? ".");
        const entries = await readdir(folder, { withFileTypes: true });
        entries.sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
        );
        const lines = await Promise.all(
          entries.slice(0, MAX_ENTRIES).map(async (entry) => {
            if (entry.isDirectory()) return `${entry.name}/`;
            const { size } = await lstat(join(folder, entry.name));
            return `${entry.name}\t${size}`;
          }),
        );
        const more = entries.length - lines.length;
        return lines.join("\n") + (more > 0 ? `\n… ${more} more` : "");
      }),

    /**
     * Replace exact text. It must appear exactly once, unless `replace_all`. Empty `old_text`
     * creates a file that doesn't exist yet, or fills an empty one.
     */
    edit: (input: {
      path: string;
      old_text: string;
      new_text: string;
      replace_all?: boolean | undefined;
    }) =>
      refusing(async () => {
        const path = at(input.path);
        const found = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (found && found.size > MAX_EDIT_BYTES)
          throw new ExecRefused(`${input.path} is too large to edit here.`);
        const before = found ? await text(path) : "";
        let after: string;
        if (input.old_text === "") {
          if (before !== "")
            throw new ExecRefused(`${input.path} isn't empty: say which text to replace.`);
          after = input.new_text;
        } else {
          if (!found) throw new ExecRefused(`No such file: ${input.path}`);
          const count = before.split(input.old_text).length - 1;
          if (count === 0) throw new ExecRefused(`That text isn't in ${input.path}.`);
          if (count > 1 && !input.replace_all)
            throw new ExecRefused(
              `That text is in ${input.path} ${count} times. Give more of it, or pass replace_all.`,
            );
          after = before.split(input.old_text).join(input.new_text);
        }
        if (after === before) throw new ExecRefused("That edit changes nothing.");
        // Written whole, keeping the file's mode.
        const temporary = join(dirname(path), `.agentexec-${randomBytes(6).toString("hex")}`);
        try {
          await writeFile(temporary, after, found ? { mode: found.mode } : {});
          await rename(temporary, path);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
        return cut(createTwoFilesPatch(input.path, input.path, before, after), MAX_READ_CHARS);
      }),
  };
}
