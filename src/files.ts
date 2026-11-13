// Reading, listing and editing files. An edit replaces exact text and answers with a diff.
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import { cut } from "./output.ts";
import { ExecRefused } from "./sessions.ts";

const DEFAULT_LINES = 2_000;
const MAX_READ_CHARS = 28_000;
const MAX_LINE_CHARS = 2_000;
export const MAX_ENTRIES = 1_000;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;
/**
 * The largest picture `read` answers. As base64 it is 4 MiB, under the 5 MB a model's API takes
 * for one picture.
 */
export const MAX_PICTURE_BYTES = 3 * 1024 * 1024;

/** A picture as `read` answers it. */
export interface Picture {
  mimeType: string;
  bytes: Buffer;
}

/** Which kind of picture a file is, by how it begins, of the kinds a model is shown. */
async function pictureKind(path: string): Promise<string | undefined> {
  const file = await open(path);
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(12), 0, 12, 0);
    const start = buffer.toString("latin1", 0, bytesRead);
    if (start.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
    if (start.startsWith("\xff\xd8\xff")) return "image/jpeg";
    if (start.startsWith("GIF87a") || start.startsWith("GIF89a")) return "image/gif";
    if (start.startsWith("RIFF") && start.slice(8) === "WEBP") return "image/webp";
    return undefined;
  } finally {
    await file.close();
  }
}

const reason = (error: unknown) => {
  const { code, path } = error as NodeJS.ErrnoException;
  if (code === "ENOENT") return `No such file or folder: ${path}`;
  if (code === "EISDIR") return `${path} is a folder.`;
  if (code === "ENOTDIR") return `${path} isn't a folder.`;
  if (code === "EACCES" || code === "EPERM") return `Not allowed: ${path}`;
  return error instanceof Error ? error.message : String(error);
};
export const refusing = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ExecRefused) throw error;
    throw new ExecRefused(reason(error));
  }
};

/** A folder's entries in the order they are shown: folders, then files, each by name. */
export const foldersFirst = (a: Dirent, b: Dirent) =>
  Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name);

/** Where the file tools reach: the workspace, or the whole machine. */
export type Reach = "workspace" | "machine";

/** The real path to use for a path the model gave the file tools. */
export type Resolve = (path: string) => Promise<string>;

/**
 * Paths for the file tools. Relative ones start at `root`, which must itself be a real path, and
 * links are followed. At `workspace` a path must stay inside `root`: a check, not a boundary, as
 * only the host running this can make one. At `machine` it may be anywhere.
 */
export const resolver =
  (root: string, reach: Reach): Resolve =>
  async (path) => {
    const found = await real(resolve(root, path));
    if (reach === "machine") {
      if (found === undefined) throw new ExecRefused(`${path} is a link to nothing.`);
      return found;
    }
    if (found === undefined || (found !== root && !found.startsWith(root + sep)))
      throw new ExecRefused(`${path} is outside the workspace.`);
    return found;
  };

/** Where `path` really is, following links, if that is inside `root`. */
export const inside = (root: string, path: string) => resolver(root, "workspace")(path);

/**
 * Where `at` really is, following links. One that doesn't exist yet is placed by the nearest
 * folder above it that does; one below a link that points nowhere has no place.
 */
async function real(at: string): Promise<string | undefined> {
  try {
    return await realpath(at);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    if (
      await lstat(at).then(
        () => true,
        () => false,
      )
    )
      return undefined;
    const above = dirname(at);
    if (above === at) return undefined;
    const placed = await real(above);
    return placed === undefined ? undefined : join(placed, basename(at));
  }
}

/**
 * What is at `path`, if it is a file, `given` being the path as it was asked for. Nothing else is
 * ever opened: a pipe, say, could wait for good.
 */
export async function aFile(path: string, given: string) {
  const found = await stat(path);
  if (found.isDirectory()) throw new ExecRefused(`${given} is a folder.`);
  if (!found.isFile()) throw new ExecRefused(`${given} isn't a file that can be read.`);
  return found;
}

export function createFiles(at: Resolve) {
  /** A file's text, `given` being the path as it was asked for. */
  const text = async (path: string, given: string) => {
    await aFile(path, given);
    const bytes = await readFile(path);
    if (bytes.includes(0)) throw new ExecRefused(`${given} is a binary file.`);
    return bytes.toString("utf8");
  };

  return {
    /** Numbered lines of a file, or the file itself where it is a picture. */
    read: (input: { path: string; offset?: number | undefined; limit?: number | undefined }) =>
      refusing(async (): Promise<string | Picture> => {
        const path = await at(input.path);
        const { size } = await aFile(path, input.path);
        const mimeType = await pictureKind(path);
        if (mimeType) {
          // Its size is known before any of it is read, so one too large is never held.
          if (size > MAX_PICTURE_BYTES)
            throw new ExecRefused(
              `${input.path} is too large to read as a picture: ${size.toLocaleString("en-US")} bytes, and the most is ${MAX_PICTURE_BYTES.toLocaleString("en-US")}.`,
            );
          return { mimeType, bytes: await readFile(path) };
        }
        const lines = (await text(path, input.path)).split("\n");
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
        const folder = await at(input.path ?? ".");
        const entries = await readdir(folder, { withFileTypes: true });
        entries.sort(foldersFirst);
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
        const path = await at(input.path);
        const found = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (found && found.size > MAX_EDIT_BYTES)
          throw new ExecRefused(`${input.path} is too large to edit here.`);
        const before = found ? await text(path, input.path) : "";
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
        // Written whole, keeping the file's permissions.
        const temporary = join(dirname(path), `.agentexec-${randomBytes(6).toString("hex")}`);
        try {
          await writeFile(temporary, after, found ? { mode: found.mode } : {});
          // Its permissions, set again because the umask cuts the mode a file is made with.
          if (found) await chmod(temporary, found.mode & 0o777);
          await rename(temporary, path);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
        return cut(createTwoFilesPatch(input.path, input.path, before, after), MAX_READ_CHARS);
      }),
  };
}
