# AgentExec

A terminal and files for an agent: six tools over MCP on stdio. It has no telemetry, holds no credentials, and depends on nothing but Node 22.15 or later: the build is one file.

```sh
node dist/agentexec.js --workspace /path/to/folder --level files
```

`--level` decides which tools it offers, each level containing the one before: `read` (the default) has `read`, `list` and `search`; `files` adds `edit`; `terminal` adds `exec_command` and `write_stdin`.

It acts with the rights of whoever starts it. The file tools stay inside the workspace, following links, but that is a check and not a boundary, and at `terminal` a command can reach anything those rights can. Run it somewhere that is safe for an agent to act.

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

`npm test` runs the conformance suite against the bundled server through the official TypeScript and Python MCP clients. The Python one needs `pip install -r requirements-test.txt`, or a Python that has it in `AGENTEXEC_PYTHON`.

## Licence

Apache-2.0.
