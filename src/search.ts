// Searching files for text, and finding the ones that changed. Both walk the tree on a thread of
// their own: a slow pattern or a huge tree can't hold up the commands, and is stopped at its
// deadline.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import ignore, { type Ignore } from "ignore";
import type { placer } from "./files.ts";
import type { FileChange, FileChanges } from "./lib.ts";
import { ExecRefused } from "./sessions.ts";

const DEADLINE_MS = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 500;
const DEFAULT_MATCHES = 200;
const MAX_CHANGES = 1_000;
/** Folders no search wants, whatever the ignore files say. */
const SKIPPED = new Set([".git", "node_modules"]);

export interface SearchInput {
  pattern: string;
  path?: string | undefined;
  regex?: boolean | undefined;
  ignore_case?: boolean | undefined;
  limit?: number | undefined;
}
interface SearchJob extends SearchInput {
  root: string;
  agentexecSearch: true;
}
interface ChangedJob {
  root: string;
  /** Milliseconds since the epoch: files modified after it are wanted. */
  since: number;
  agentexecSearch: true;
}
type Job = SearchJob | ChangedJob;

/**
 * Every file under a folder, until `visit` answers false. It skips what `.gitignore` files ignore,
 * the folders no one wants, links, and what can't be read.
 */
function eachFile(start: string, visit: (file: string) => boolean) {
  /** A folder's own ignore file on top of those above it, each relative to where it was read. */
  const walk = (folder: string, rules: { base: string; ignore: Ignore }[]): boolean => {
    let here = rules;
    try {
      const own = join(folder, ".gitignore");
      // Only a file is opened here too.
      if (statSync(own).isFile())
        here = [...rules, { base: folder, ignore: ignore().add(readFileSync(own, "utf8")) }];
    } catch {
      // No ignore file here.
    }
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      const suffix = entry.isDirectory() ? "/" : "";
      const ignored = here.some((rule) =>
        rule.ignore.ignores(relative(rule.base, path).split(sep).join("/") + suffix),
      );
      if (ignored) continue;
      try {
        const carryOn = entry.isDirectory() ? walk(path, here) : !entry.isFile() || visit(path);
        if (!carryOn) return false;
      } catch {
        // Unreadable: not something to report on.
      }
    }
    return true;
  };
  walk(start, []);
}

function searched(job: SearchJob): string {
  const start = resolve(job.root, job.path ?? ".");
  const pattern = job.regex ? job.pattern : job.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(pattern, job.ignore_case ? "i" : "");
  const limit = job.limit ?? DEFAULT_MATCHES;
  const out: string[] = [];
  // From the workspace where it is in it, and whole where it isn't.
  const name = (path: string) => {
    const from = relative(job.root, path);
    return from.startsWith("..") ? path : from || path;
  };

  const scan = (file: string) => {
    const found = statSync(file);
    // Only a file is opened: a pipe, say, could wait for good.
    if (!found.isFile() || found.size > MAX_FILE_BYTES) return;
    const bytes = readFileSync(file);
    if (bytes.includes(0)) return;
    bytes
      .toString("utf8")
      .split("\n")
      .forEach((line, i) => {
        if (out.length <= limit && matcher.test(line))
          out.push(`${name(file)}:${i + 1}:${line.slice(0, MAX_LINE_CHARS)}`);
      });
  };

  if (statSync(start).isDirectory())
    eachFile(start, (file) => {
      scan(file);
      return out.length <= limit;
    });
  else scan(start);
  const more = out.length > limit;
  return (more ? [...out.slice(0, limit), `… more than ${limit} matches`] : out).join("\n");
}

function changed(job: ChangedJob): FileChanges {
  const changes: FileChange[] = [];
  let more = false;
  /** Keep the newest thousand of those found so far. */
  const newest = () => {
    changes.sort(
      (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path),
    );
    if (changes.length <= MAX_CHANGES) return;
    more = true;
    changes.length = MAX_CHANGES;
  };
  eachFile(job.root, (file) => {
    const { mtime, size } = statSync(file);
    // In whole milliseconds, as the date in the answer is: asking again from a file's own date
    // doesn't bring it back.
    if (mtime.getTime() > job.since) {
      changes.push({
        path: relative(job.root, file).split(sep).join("/"),
        size,
        modifiedAt: mtime.toISOString(),
      });
      if (changes.length >= 2 * MAX_CHANGES) newest();
    }
    return true;
  });
  newest();
  return { changes, more };
}

/** Do a job on a thread of this same file, stopped at the deadline. */
function onThread<T>(job: Job, what: string): Promise<T> {
  return new Promise((done, failed) => {
    // This same file, whichever bundle it is in: see the end of it.
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: job });
    const timer = setTimeout(() => {
      void worker.terminate();
      failed(new ExecRefused(`${what} took over ${DEADLINE_MS / 1000} s, so it was stopped.`));
    }, DEADLINE_MS);
    worker.once("message", (answer: T) => {
      clearTimeout(timer);
      void worker.terminate();
      done(answer);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      failed(new ExecRefused(error.message));
    });
  });
}

export async function search(
  root: string,
  at: ReturnType<typeof placer>,
  input: SearchInput,
): Promise<string> {
  const path = await at(input.path ?? ".");
  return onThread({ ...input, path, root, agentexecSearch: true }, "That search");
}

/** The newest thousand of the files in the workspace modified after a time, the newest first. */
export function changedSince(root: string, since: number): Promise<FileChanges> {
  return onThread({ root, since, agentexecSearch: true }, "Looking for what changed");
}

// On one of those threads, this module is what does the work. Whatever bundles it must not start
// anything of its own off the main thread.
if (!isMainThread && (workerData as Job | null)?.agentexecSearch) {
  const job = workerData as Job;
  parentPort?.postMessage("since" in job ? changed(job) : searched(job));
}
