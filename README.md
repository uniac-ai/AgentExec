# AgentExec

A terminal and files for an agent: seven MCP tools, over stdio or Streamable HTTP. It has no telemetry, holds no credentials, and depends on nothing but Node 22.15 or later: the build is one file.

```sh
node dist/agentexec.js --workspace /path/to/folder --level files
```

`--level` decides which tools it offers, each level containing the one before: `read` (the default) has `read`, `list` and `search`; `files` adds `edit`; `terminal` adds `exec_command`, `write_stdin` and `list_sessions`.

It acts with the rights of whoever starts it. The file tools stay inside the workspace, following links, but that is a check and not a boundary. At `terminal` a command can reach anything those rights can. Run it somewhere that is safe for an agent to act.

`--reach machine` (`reach: "machine"` in the library) lets the file tools reach the whole machine. Relative paths still start at the workspace, and `search` names a file outside it by its whole path:

```sh
node dist/agentexec.js --workspace /path/to/folder --level files --reach machine
```

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
// To watch every terminal as it runs, without waiting for the agent to ask:
const stop = exec.onCommand((event) => console.log(event));
// When you're done, which stops any terminal still running:
await exec.close();
```

A host can add tools to AgentExec's own, for what it knows of the workspace and AgentExec doesn't:

```js
import { hostname } from "node:os";

const exec = createAgentExec({
  workspace: "/path/to/folder",
  extraTools: [
    {
      name: "about",
      description: "Which machine this workspace is on.",
      readOnly: true,
      call: () => hostname(),
    },
  ],
});
```

A tool added this way takes no input and answers text. It is offered at every level, whatever `level` is. One that throws is answered as a refusal, with the error's message, which the agent reads. `readOnly` tells an agent's client that it only reads. A name of one of AgentExec's seven, or one given twice, is refused when `createAgentExec` is called.

A host can also add a line to a tool's answer, for something it knows that AgentExec doesn't, such as that a person just typed in the same terminal:

```js
const typedBy = new Map(); // session id → when the person last typed there, kept by the host

const exec = createAgentExec({
  workspace: "/path/to/folder",
  note: (tool, input) =>
    tool === "write_stdin" && typedBy.has(input.session_id)
      ? `The person typed in this terminal ${Math.round((Date.now() - typedBy.get(input.session_id)) / 1000)} s ago.`
      : undefined,
});
```

- **When it is asked:** before each tool runs, tools added with `extraTools` among them, so it describes how things stand going in, not what the tool did. It gets the tool's name and a copy of the input, `{}` for a tool that takes none; changing the copy doesn't change the call.
- **What the agent sees:** the tool's answer as it was, then the line as a text of its own: `content: [{ type: "text", text: "<the answer>" }, { type: "text", text: "<the line>" }]`. That holds on a refusal and on an image too. `structuredContent`, where an answer has one, is unchanged. The agent reads the line as part of the answer, so keep it short and plain, and put nothing in it you wouldn't show the agent.
- **When nothing is added:** when it gives nothing, an empty string or anything but a string, or throws. It must return the line itself, not a promise. A throw isn't reported anywhere.
- **Library only:** the command line has no flag for it. Without it, nothing changes.

Each terminal gives a `start` (its `cmd`, `workdir` and `at`, who started it as `by`, and `tty`), `output` as it's written (`text`, and for a command its `stream`, `stdout` or `stderr`), and an `exit` (`exitCode` and `at`). Each event has the `id` its session's answers carry as `session_id`. The agent's answers don't change.

A terminal is a command the agent started, or a shell a person opened. Both are in one list, which the host reaches for the person as the agent reaches it through its tools:

```js
import { spawn } from "node-pty";

const exec = createAgentExec({ workspace: "/path/to/folder", level: "terminal", pty: spawn });
const terminals = exec.terminals.list();
// [{ id: "s_…", by: "agent", cmd: "npm test", workdir: "…", tty: false, at: "…", output: "…" }, ...]
const id = exec.terminals.open({ columns: 80, rows: 24 });
exec.terminals.write(id, "ls\n");
exec.terminals.resize(id, 120, 40);
await exec.terminals.stop(id);
```

- `list` gives every terminal, the oldest first: those running and the last 64 that ended, which also have `exitCode` and `endedAt`. `output` is the last 65,536 characters each has written, for someone who comes late. `by` is `agent` or `person`: the way in it came, and nothing more.
- `open` starts a person's login shell in the workspace and gives its id. It needs the `terminal` level, and a terminal device to run on: AgentExec brings none, so the host passes one as `pty`, a function in the shape of `spawn` from [node-pty](https://github.com/microsoft/node-pty). Without it `open` is refused and everything else works.
- `write` types into any running terminal, the agent's commands included. `resize` is for a shell. `stop` ends one: an interrupt, or a hangup for a shell, then a kill a second later. A program in a shell that ignores the hangup outlives it.
- The agent sees a person's shell in `list_sessions`, reads it and types into it with `write_stdin`. What a person's shell shows is the agent's to read, and whatever that shell is signed in to, the agent can type into.

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
- `read` gives a range of a file's bytes from an offset, with the file's whole size, so a large file is read a range at a time. A range of no bytes or of over 1,048,576 is refused, as is anything that isn't a file.
- `changed` gives the files modified after a time, in whole milliseconds: the newest thousand, the newest first, and `more` says there were others. It skips what `.gitignore` files ignore, `.git`, `node_modules` and links, a file that was removed isn't one of them, and like `search` it is stopped after 20 seconds.
- `upload` writes a file a part at a time. Nothing is at its path until `finish` puts it there whole, over any file that was there and with that file's permissions; `abort` gives up. It makes no folders, and it is refused at the `read` level, which otherwise decides only the tools. Until it is finished its part-written file sits beside its path as `.agentexec-…`, where a listing, and the agent, can see it. `exec.close()` gives up any upload still open.

They stay inside the workspace whatever `reach` is, and refuse with an error whose message says why.

If you bundle it into a file of your own, don't start anything off the main thread: its search, and `changed`, run that same file on a worker thread.

## Tools

| Tool            | What it does                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec_command`  | Runs `cmd` in a login shell, in `workdir` or the workspace. Waits `yield_time_ms` (250 to 30000, default 10000), then answers. A command still running keeps running and gets a `session_id`.                                                       |
| `write_stdin`   | Types `chars` into a running session and answers with what it wrote since. With no `chars`, waits (5000 to 30000 ms, default 5000) for more. `\u0003` interrupts it, `\u0004` ends its input.                                                       |
| `list_sessions` | The terminals here, running or lately ended: each one's `session_id`, who started it (`agent` or `person`), since when, its exit code or `running`, and its command.                                                                                |
| `read`          | A text file as numbered lines, from `offset` (1) for `limit` lines (2000). A PNG, JPEG, GIF or WebP of up to 3 MiB, told by how its bytes begin, as an image with a line of text naming it. A larger picture and any other binary file are refused. |
| `list`          | A folder: folders end in `/`, files give their size in bytes.                                                                                                                                                                                       |
| `search`        | Text under a folder, as `path:line:text`. Exact text unless `regex`. Skips what `.gitignore` ignores, `.git` and `node_modules`.                                                                                                                    |
| `edit`          | Replaces exact text, which must appear once unless `replace_all`, and answers with a unified diff. An empty `old_text` creates a new file.                                                                                                          |

Relative paths are relative to the workspace, and a path that really lies outside it is refused, unless the file tools reach the whole machine. `search` then names a file outside the workspace by its whole path. A failed tool sets MCP's `isError`; a command that exits non-zero is an answer, not a failure.

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

A session is what the library calls a terminal. Every command is one from its start, and so is a shell a person opened through a host. `list_sessions` gives them all, so whoever can call the tools can see every session and type into any that is running: agents sharing one server aren't kept apart. It shows a command as its first line, or its first 200 characters.

`write_stdin` reaches a session by its id while it runs. If no answer has carried its exit code yet, it reaches it once more after it ends, for what it wrote last and that code. A person's shell is on a terminal device, so what is typed into it goes in as keys: it joins anything already typed there, Ctrl-D at its prompt closes it, and its text has the shell's prompts and colours in it.

Once 64 have ended, each that ends takes one off the list: the earliest whose exit code an answer has carried, so one nobody has read stays while there is another to drop.

At most 64 run at once, a person's shells among them; past that a new one is refused, and none is evicted. Over stdio, closing the connection stops every one still running. Over HTTP and in a host they run until it stops.

A caller can put the sessions it starts in a group, to stop them together. It sends a word with `exec_command`, as `agentexec/group` in the call's `_meta`: `{"_meta": {"agentexec/group": "<word>"}}`. The word is a string of 1 to 200 characters that means nothing here and names nobody; a call with anything else for it is refused. The request `agentexec/group/stop`, with `{"group": "<word>"}` as its params, ends every running session of that group and answers `{"stopped": <how many>}`: an interrupt, then a kill a second later. A call still waiting on one of them is answered then, with its exit code.

- It is a request and not a tool, so it is for whatever calls the tools, and the agent isn't shown it. It is there at the `terminal` level. Whoever can reach the server can stop any group by its word.
- A session started with no word is in no group, and neither is a person's shell: nothing stops them this way. Nor does closing a call's request, which leaves its command running.
- A process that left its command's process group, a daemon or anything under `setsid`, isn't signalled. Its session ends and is counted, and that process runs on.

## Differences from Codex

`exec_command` and `write_stdin` follow [OpenAI Codex](https://github.com/openai/codex); see NOTICE. They differ in three ways:

- Commands use pipes, not a terminal, so there is no `tty` option. Ctrl-C and Ctrl-D are delivered as a signal and an end of input.
- A poll waits at most 30 seconds rather than 300, so that one call stays inside a host's own time limit.
- Sessions are named by random strings, not small numbers.

`list_sessions` is AgentExec's own, and so is a person's shell among the sessions, which is on a terminal device.

## Tests

`npm test` runs the conformance suite against the bundled server through the official TypeScript MCP client, over stdio and HTTP, and the official Python one. The Python one needs `pip install -r requirements-test.txt`, or a Python that has it in `AGENTEXEC_PYTHON`.

## Licence

Apache-2.0.
