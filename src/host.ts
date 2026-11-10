// The workspace's files for the host itself, in bytes and with dates: what a person's file window
// needs, and what the agent's tools, made for a model to read, don't give. None of it is a tool.
import { randomBytes } from "node:crypto";
import { lstat, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { foldersFirst, inside, MAX_ENTRIES, refusing } from "./files.ts";
import type { FileEntry, FileUpload, HostFiles } from "./lib.ts";
import { changedSince } from "./search.ts";
import type { Level } from "./server.ts";
import { ExecRefused } from "./sessions.ts";

/** The most one read takes. */
export const MAX_READ_BYTES = 1024 * 1024;

export function createHostFiles(root: string, level: Level) {
  const uploads = new Set<FileUpload>();
  /** How many times the host has closed, for an upload to see that it did while it was opening. */
  let closes = 0;

  const files: HostFiles = {
    list: (path = ".") =>
      refusing(async () => {
        const folder = await inside(root, path);
        const found = await readdir(folder, { withFileTypes: true });
        found.sort(foldersFirst);
        const entries = await Promise.all(
          found.slice(0, MAX_ENTRIES).map(async (entry): Promise<FileEntry | undefined> => {
            // One that has gone since the folder was read is left out.
            const own = await lstat(join(folder, entry.name)).catch(() => undefined);
            return (
              own && {
                name: entry.name,
                kind: entry.isDirectory() ? "folder" : entry.isSymbolicLink() ? "link" : "file",
                size: own.size,
                modifiedAt: own.mtime.toISOString(),
              }
            );
          }),
        );
        return {
          entries: entries.filter((entry) => entry !== undefined),
          more: found.length > MAX_ENTRIES,
        };
      }),

    read: (path, offset, length) =>
      refusing(async () => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > MAX_READ_BYTES
        )
          throw new ExecRefused("A read starts at 0 or later and takes 1 to 1,048,576 bytes.");
        const real = await inside(root, path);
        const found = await stat(real);
        if (found.isDirectory()) throw new ExecRefused(`${path} is a folder.`);
        // Opening anything else, a pipe say, could wait for good.
        if (!found.isFile()) throw new ExecRefused(`${path} isn't a file that can be read.`);
        const file = await open(real, "r");
        try {
          const bytes = Buffer.alloc(Math.max(0, Math.min(length, found.size - offset)));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
          return {
            bytes: bytes.subarray(0, bytesRead),
            size: found.size,
            modifiedAt: found.mtime.toISOString(),
          };
        } finally {
          await file.close();
        }
      }),

    changed: (since) =>
      refusing(async () => {
        const from = since.getTime();
        if (Number.isNaN(from)) throw new ExecRefused("That isn't a time.");
        return changedSince(root, from);
      }),

    upload: (path) =>
      refusing(async () => {
        if (level === "read") throw new ExecRefused("Files here can be read, not written.");
        const opening = closes;
        const target = await inside(root, path);
        const before = await stat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (before?.isDirectory()) throw new ExecRefused(`${path} is a folder.`);
        // It makes no folders: the one it goes in has to be there.
        await stat(dirname(target));
        // Written beside it and moved into place whole.
        const temporary = join(dirname(target), `.agentexec-${randomBytes(6).toString("hex")}`);
        const file = await open(temporary, "wx");
        const discard = async () => {
          await file.close().catch(() => {});
          await rm(temporary, { force: true });
        };
        let ended = false;
        let written: Promise<unknown> = Promise.resolve();
        const end = () => {
          if (ended) throw new ExecRefused("That upload has ended.");
          ended = true;
          uploads.delete(upload);
        };
        const upload: FileUpload = {
          write: (bytes) =>
            refusing(async () => {
              if (ended) throw new ExecRefused("That upload has ended.");
              // One part at a time, in the order they were given, each written in full.
              written = written.then(() => file.appendFile(bytes));
              await written;
            }),
          finish: () =>
            refusing(async () => {
              end();
              try {
                await written;
                await file.close();
                await rename(temporary, target);
              } catch (error) {
                await discard();
                throw error;
              }
              const after = await stat(target);
              return { size: after.size, modifiedAt: after.mtime.toISOString() };
            }),
          abort: () =>
            refusing(async () => {
              if (ended) return;
              end();
              await written.catch(() => {});
              await discard();
            }),
        };
        try {
          // The mode of the file it replaces, which opening with it would let the umask cut.
          if (before) await file.chmod(before.mode & 0o7777);
          if (closes !== opening) throw new ExecRefused("It closed before that upload began.");
        } catch (error) {
          await discard();
          throw error;
        }
        uploads.add(upload);
        return upload;
      }),
  };

  return {
    files,
    /** Give up every upload still open, and any that is opening. */
    close: async () => {
      closes++;
      await Promise.all([...uploads].map((upload) => upload.abort()));
    },
  };
}
