// The seven tools over MCP.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createFiles } from "./files.ts";
import { search } from "./search.ts";
import {
  type Answer,
  ExecRefused,
  formatAnswer,
  formatSessions,
  listing,
  type Sessions,
} from "./sessions.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const refused = (error: unknown) => {
  if (!(error instanceof ExecRefused)) throw error;
  return { isError: true, ...text(error.message) };
};
const answering = async (work: () => Promise<Answer>) => {
  try {
    const answer = await work();
    return { ...text(formatAnswer(answer)), structuredContent: { ...answer } };
  } catch (error) {
    return refused(error);
  }
};
const saying = async (work: () => Promise<string>) => {
  try {
    return text(await work());
  } catch (error) {
    return refused(error);
  }
};

const Answered = {
  exit_code: z.number().nullable().describe("The exit code, or null while it is still running."),
  seconds: z.number().describe("How long this call waited."),
  session_id: z.string().nullable().describe("For write_stdin, while it is still running."),
  text: z.string().describe("What it wrote since the last call, cut in the middle if long."),
};
const YieldTime = z.number().int().positive().optional();
const MaxTokens = z.number().int().positive().optional();
const READ_ONLY = { readOnlyHint: true };

/** How far an agent reaches, each level containing the one before. */
export const LEVELS = ["read", "files", "terminal"] as const;
export type Level = (typeof LEVELS)[number];

export function createServer(root: string, sessions: Sessions, version: string, level: Level) {
  const server = new McpServer({ name: "agentexec", version });
  const files = createFiles(root);

  if (level === "terminal") {
    server.registerTool(
      "exec_command",
      {
        description:
          "Runs a command in a shell. Answers when it ends, or after yield_time_ms with a session_id while it keeps running; use write_stdin to check on it or type into it. Every answer gives exit_code, seconds, session_id and text.",
        inputSchema: {
          cmd: z.string().min(1).describe("The command, run by a login shell."),
          workdir: z.string().optional().describe("Where to run it; the workspace by default."),
          yield_time_ms: YieldTime.describe("How long to wait: 250 to 30000, by default 10000."),
          max_output_tokens: MaxTokens.describe("About how much output to return."),
        },
        outputSchema: Answered,
        annotations: { destructiveHint: true },
      },
      (input) => answering(() => sessions.exec(input)),
    );
    server.registerTool(
      "write_stdin",
      {
        description:
          "Types into a running command and returns what it wrote since. With no chars, waits and returns what it has written. A Ctrl-C character (\\u0003) interrupts it; Ctrl-D (\\u0004) ends its input. It also reaches a shell a person opened, by its id from list_sessions: there these are keys, what you type joins anything already typed, and Ctrl-D at its prompt closes it. Once an answer has given a session's exit code, that session is refused.",
        inputSchema: {
          session_id: z.string().min(1).describe("From exec_command's answer, or list_sessions."),
          chars: z.string().optional().describe("What to type; include \\n to press Enter."),
          yield_time_ms: YieldTime.describe(
            "How long to wait: with chars 250 to 30000, by default 250; with none 5000 to 30000.",
          ),
          max_output_tokens: MaxTokens.describe("About how much output to return."),
        },
        outputSchema: Answered,
        annotations: { destructiveHint: true },
      },
      (input) => answering(() => sessions.write(input)),
    );
    server.registerTool(
      "list_sessions",
      {
        description:
          "Lists the sessions here, running or lately ended: each command exec_command started, and each shell a person opened. Gives each one's session_id for write_stdin, who started it, since when, its exit code and the start of its command.",
        outputSchema: {
          sessions: z.array(
            z.object({
              session_id: z.string(),
              started_by: z.enum(["agent", "person"]).describe("A person's is their own shell."),
              since: z.string().describe("When it started."),
              exit_code: z.number().nullable().describe("Null while it is still running."),
              cmd: z.string().describe("Its first line, or the start of it."),
            }),
          ),
        },
        annotations: READ_ONLY,
      },
      () => {
        const listed = listing(sessions.list());
        return { ...text(formatSessions(listed)), structuredContent: { sessions: listed } };
      },
    );
  }
  server.registerTool(
    "read",
    {
      description: "Reads a text file as numbered lines.",
      inputSchema: {
        path: z.string().min(1).describe("Inside the workspace; relative to it, or absolute."),
        offset: z.number().int().positive().optional().describe("The first line, from 1."),
        limit: z.number().int().positive().optional().describe("How many lines; 2000 by default."),
      },
      annotations: READ_ONLY,
    },
    (input) => saying(() => files.read(input)),
  );
  server.registerTool(
    "list",
    {
      description: "Lists a folder: folders end in /, and files give their size in bytes.",
      inputSchema: { path: z.string().optional().describe("The workspace by default.") },
      annotations: READ_ONLY,
    },
    (input) => saying(() => files.list(input)),
  );
  server.registerTool(
    "search",
    {
      description:
        "Searches text files under a folder, as path:line:text. Skips what .gitignore ignores, .git and node_modules.",
      inputSchema: {
        pattern: z.string().min(1).describe("Exact text, or a regular expression with regex."),
        path: z.string().optional().describe("A folder or file; the workspace by default."),
        regex: z.boolean().optional(),
        ignore_case: z.boolean().optional(),
        limit: z.number().int().positive().optional().describe("Most matches; 200 by default."),
      },
      annotations: READ_ONLY,
    },
    (input) => saying(() => search(root, input)),
  );
  if (level !== "read")
    server.registerTool(
      "edit",
      {
        description:
          "Replaces exact text in a file and answers with a unified diff. old_text must appear exactly once unless replace_all. An empty old_text creates a new file.",
        inputSchema: {
          path: z.string().min(1).describe("Inside the workspace; relative to it, or absolute."),
          old_text: z.string().describe("The exact text to replace, whitespace included."),
          new_text: z.string().describe("What to put in its place."),
          replace_all: z.boolean().optional(),
        },
        annotations: { destructiveHint: true },
      },
      (input) => saying(() => files.edit(input)),
    );
  return server;
}
