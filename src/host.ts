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

/** The most one read returns. */
export const MAX_READ_BYTES = 1024 * 1024;

export function createHostFiles(root: string, level: Level) {
  const uploads = new Set<FileUpload>();

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
        const whole = (value: number) => Number.isSafeInteger(value);
        if (!whole(offset) || offset < 0 || !whole(length) || length < 1 || length > MAX_READ_BYTES)
          throw new ExecRefused(
            `A read starts at 0 or later and takes 1 to ${MAX_READ_BYTES} bytes.`,
          );
        const file = await open(await inside(root, path), "r");
        try {
          const found = await file.stat();
          if (found.isDirectory()) throw new ExecRefused(`${path} is a folder.`);
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
        const target = await inside(root, path);
        const before = await stat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (before?.isDirectory()) throw new ExecRefused(`${path} is a folder.`);
        // It makes no folders: the one it goes in has to be there.
        await stat(dirname(target));
        // Written beside it and moved into place, keeping the mode of a file it replaces.
        const temporary = join(dirname(target), `.agentexec-${randomBytes(6).toString("hex")}`);
        const file = await open(temporary, "wx", before ? before.mode & 0o7777 : 0o666);
        let ended = false;
        let written: Promise<unknown> = Promise.resolve();
        const end = async () => {
          ended = true;
          uploads.delete(upload);
          await written.catch(() => {});
          await file.close();
        };
        const live = () => {
          if (ended) throw new ExecRefused("That upload has ended.");
        };
        const upload: FileUpload = {
          write: (bytes) =>
            refusing(async () => {
              live();
              // One part at a time, in the order they were given.
              written = written.then(() => file.write(bytes));
              await written;
            }),
          finish: () =>
            refusing(async () => {
              live();
              await end();
              try {
                await written;
                await rename(temporary, target);
              } catch (error) {
                await rm(temporary, { force: true });
                throw error;
              }
              const after = await stat(target);
              return { size: after.size, modifiedAt: after.mtime.toISOString() };
            }),
          abort: async () => {
            if (ended) return;
            await end();
            await rm(temporary, { force: true });
          },
        };
        uploads.add(upload);
        return upload;
      }),
  };

  return {
    files,
    /** Give up every upload still open. */
    close: async () => {
      await Promise.all([...uploads].map((upload) => upload.abort()));
    },
  };
}
