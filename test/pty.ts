// A terminal device for the tests, from Python's pty module, in the shape of node-pty's `spawn`.
// What runs on it has a real terminal. Its size can't be changed from here, so sizes are recorded.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { PtySpawn } from "../src/lib.ts";

const PROGRAM = `
import os, pty, sys
code = os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:]))
sys.exit(code if code >= 0 else 128 - code)
`;

export function pythonPty() {
  /** Each size asked for, the first one first. */
  const sizes: [number, number][] = [];
  const open: PtySpawn = (file, args, options) => {
    sizes.push([options.cols, options.rows]);
    const child = spawn(process.env.AGENTEXEC_PYTHON ?? "python3", ["-c", PROGRAM, file, ...args], {
      cwd: options.cwd,
      env: { ...options.env, TERM: options.name },
      stdio: "pipe",
    });
    child.stdin.on("error", () => {});
    return {
      onData: (listener) => child.stdout.on("data", (chunk: Buffer) => listener(String(chunk))),
      onExit: (listener) =>
        child.once("exit", (code, signal) =>
          listener({
            exitCode: code ?? 0,
            ...(signal ? { signal: constants.signals[signal] } : {}),
          }),
        ),
      write: (data) => void child.stdin.write(data),
      resize: (columns, rows) => void sizes.push([columns, rows]),
      kill: (signal) => void child.kill(signal as NodeJS.Signals),
    };
  };
  return { open, sizes };
}
