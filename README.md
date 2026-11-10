# AgentExec

A terminal and files for an agent: six MCP tools, over stdio or Streamable HTTP. It has no telemetry, holds no credentials, and depends on nothing but Node 22.15 or later: the build is one file.

```sh
node dist/agentexec.js --workspace /path/to/folder --level files
```

`--level` decides which tools it offers, each level containing the one before: `read` (the default) has `read`, `list` and `search`; `files` adds `edit`; `terminal` adds `exec_command` and `write_stdin`.

It acts with the rights of whoever starts it. The file tools stay inside the workspace, following links, but that is a check and not a boundary, and at `terminal` a command can reach anything those rights can. Run it somewhere that is safe for an agent to act.

To serve it over HTTP, name a loopback address and set the token clients must send. MCP is at `/mcp`:

```sh
AGENTEXEC_TOKEN=... node dist/agentexec.js --workspace /path/to/folder --level files --http 127.0.0.1:8123
```

It has no TLS of its own, so it refuses any other address. To serve it elsewhere, mount it as a library behind something that does:

```js
import { createAgentExec } from "@agentorg/exec";

const exec = createAgentExec({ workspace: "/path/to/folder", level: "files" });
// In a request handler, under any path, once you have decided the caller may reach it:
await exec.handle(request, response);
// To watch the agent's commands as they run, without waiting for it to ask:
const stop = exec.onCommand((event) => console.log(event));
// When you're done, which stops any command still running:
await exec.close();
```

Each command gives a `start` (its `cmd`, `workdir` and `at`), `output` as it's written (`stream` is `stdout` or `stderr`, and `text`), and an `exit` (`exitCode` and `at`). Each event has the `id` its session's answers carry as `session_id`. The agent's answers don't change.

The host can also reach the workspace's files itself, in bytes and with dates, for a person's file window or anything else the tools' text doesn't serve. None of this is a tool, and the agent's tools don't change:

```js
const { entries, more } = await exec.files.list("src");
// [{ name: "lib", kind: "folder", size: 96, modifiedAt: "2026-01-02T03:04:05.000Z" }, ...]
const { bytes, size, modifiedAt } = await exec.files.read("logo.png", 0, 1024 * 1024);
const { changes } = await exec.files.changed(new Date(Date.now() - 60_000));
// [{ path: "src/lib/a.ts", size: 812, modifiedAt: "..." }, ...]
const upload = await exec.files.upload("data/in.csv");
await upload.write(part);
await upload.finish();
```

- `list` gives a folder's first thousand entries, folders first; `more` says there were others. `kind` is `file`, `folder` or `link`, and a link's size and date are its own.
- `read` gives a range of a file's bytes from an offset, with the file's whole size, so a large file is read a range at a time. A range over 1,048,576 bytes is refused, as is anything that isn't a file.
- `changed` gives the files modified after a time, in whole milliseconds: the newest thousand, the newest first, and `more` says there were others. It skips what `.gitignore` files ignore, `.git`, `node_modules` and links, and a file that was removed isn't one of them.
- `upload` writes a file a part at a time. Nothing is at its path until `finish` puts it there whole, over any file that was there and keeping that file's mode; `abort` gives up. It makes no folders, and it is refused at the `read` level, which otherwise decides only the tools. Until it is finished its part-written file sits beside its path as `.agentexec-…`, where a listing, and the agent, can see it. `exec.close()` gives up any upload still open.

They stay inside the workspace as the tools do, and refuse with an error whose message says why.

If you bundle it into a file of your own, don't start anything off the main thread: its search, and `changed`, run that same file on a worker thread.

## Tools

| Tool           | What it does                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec_command` | Runs `cmd` in a login shell, in `workdir` or the workspace. Waits `yield_time_ms` (250 to 30000, default 10000), then answers. A command still running keeps running and gets a `session_id`. |
| `write_stdin`  | Types `chars` into a running command and answers with what it wrote since. With no `chars`, waits (5000 to 30000 ms, default 5000) for more. `\u0003` interrupts it, `\u0004` ends its input. |
| `read`         | A text file as numbered lines, from `offset` (1) for `limit` lines (2000).                                                                                                                    |
| `list`         | A folder: folders end in `/`, files give their size in bytes.                                                                                                                                 |
| `search`       | Text under a folder, as `path:line:text`. Exact text unless `regex`. Skips what `.gitignore` ignores, `.git` and `node_modules`.                                                              |
| `edit`         | Replaces exact text, which must appear once unless `replace_all`, and answers with a unified diff. An empty `old_text` creates a new file.                                                    |

Relative paths are relative to the workspace, and a path that really lies outside it is refused. A failed tool sets MCP's `isError`; a command that exits non-zero is an answer, not a failure.

## The answer from `exec_command` and `write_stdin`

Always these four fields, in this order, as the result's text and, for clients that read it, as `structuredContent`:

```
exit_code: 0
seconds: 1.204
session_id: none
text:
what it wrote
```

`exit_code` is `running` while the command runs, and `session_id` is `none` once it has ended. A command stopped by a signal has 128 plus the signal's number. `text` is what it wrote since the last answer, cut in the middle past about `max_output_tokens` tokens (four characters each, 7000 by default), saying how much was cut.

## Sessions

A session id is random and is given only to the call that started the command, so agents sharing one server don't touch each other's commands. At most 64 commands run at once; past that a new one is refused, and none is evicted. Closing the connection stops every command still running.

## Differences from Codex

`exec_command` and `write_stdin` follow [OpenAI Codex](https://github.com/openai/codex); see NOTICE. They differ in three ways:

- Commands use pipes, not a terminal, so there is no `tty` option. Ctrl-C and Ctrl-D are delivered as a signal and an end of input.
- A poll waits at most 30 seconds rather than 300, so that one call stays inside a host's own time limit.
- Sessions are named by random strings, not small numbers.

## Tests

`npm test` runs the conformance suite against the bundled server through the official TypeScript MCP client, over stdio and HTTP, and the official Python one. The Python one needs `pip install -r requirements-test.txt`, or a Python that has it in `AGENTEXEC_PYTHON`.

## Licence

Apache-2.0.
