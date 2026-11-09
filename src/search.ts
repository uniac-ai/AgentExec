// Searching files for text. It runs on its own thread: a slow pattern or a huge tree can't hold up
// the commands, and is stopped at its deadline.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parentPort, Worker, workerData } from "node:worker_threads";
import ignore, { type Ignore } from "ignore";
import { inside } from "./files.ts";
import { ExecRefused } from "./sessions.ts";

const DEADLINE_MS = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 500;
const DEFAULT_MATCHES = 200;
/** Folders no search wants, whatever the ignore files say. */
const SKIPPED = new Set([".git", "node_modules"]);

export interface SearchInput {
  pattern: string;
  path?: string | undefined;
  regex?: boolean | undefined;
  ignore_case?: boolean | undefined;
  limit?: number | undefined;
}
interface Job extends SearchInput {
  root: string;
  agentexecSearch: true;
}

function run(job: Job): string {
  const start = resolve(job.root, job.path ?? ".");
  const pattern = job.regex ? job.pattern : job.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(pattern, job.ignore_case ? "i" : "");
  const limit = job.limit ?? DEFAULT_MATCHES;
  const out: string[] = [];
  const name = (path: string) => relative(job.root, path) || path;

  const scan = (file: string) => {
    if (statSync(file).size > MAX_FILE_BYTES) return;
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
  /** A folder's own ignore file on top of those above it, each relative to where it was read. */
  const walk = (folder: string, rules: { base: string; ignore: Ignore }[]) => {
    let here = rules;
    try {
      const own = ignore().add(readFileSync(join(folder, ".gitignore"), "utf8"));
      here = [...rules, { base: folder, ignore: own }];
    } catch {
      // No ignore file here.
    }
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (out.length > limit) return;
      if (SKIPPED.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      const suffix = entry.isDirectory() ? "/" : "";
      const ignored = here.some((rule) =>
        rule.ignore.ignores(relative(rule.base, path).split(sep).join("/") + suffix),
      );
      if (ignored) continue;
      try {
        if (entry.isDirectory()) walk(path, here);
        else if (entry.isFile()) scan(path);
      } catch {
        // Unreadable: not something a search can report on.
      }
    }
  };

  if (statSync(start).isDirectory()) walk(start, []);
  else scan(start);
  const more = out.length > limit;
  return (more ? [...out.slice(0, limit), `… more than ${limit} matches`] : out).join("\n");
}

/** On a search thread: do the job given and answer. Says whether this is such a thread. */
export function serveSearch(): boolean {
  const job = workerData as Job | null;
  if (!job?.agentexecSearch || !parentPort) return false;
  parentPort.postMessage(run(job));
  return true;
}

/** Search on a thread of this same file, stopped at the deadline. */
export async function search(root: string, input: SearchInput): Promise<string> {
  const path = await inside(root, input.path ?? ".");
  return new Promise((done, failed) => {
    const workerData: Job = { ...input, path, root, agentexecSearch: true };
    // The running file itself, which answers as a search thread (`serveSearch`).
    const worker = new Worker(process.argv[1] as string, { workerData });
    const timer = setTimeout(() => {
      void worker.terminate();
      failed(new ExecRefused(`That search took over ${DEADLINE_MS / 1000} s, so it was stopped.`));
    }, DEADLINE_MS);
    worker.once("message", (text: string) => {
      clearTimeout(timer);
      void worker.terminate();
      done(text);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      failed(new ExecRefused(error.message));
    });
  });
}
