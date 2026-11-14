// The seven tools over MCP, and any the host adds.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createFiles, type Picture, resolver } from "./files.ts";
import type { AgentExecOptions } from "./lib.ts";
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
/** A picture as an answer, with a line of text for whoever is shown only text. */
const pictured = (path: string, { mimeType, bytes }: Picture) => ({
  content: [
    { type: "text" as const, text: `${path}: ${mimeType}` },
    { type: "image" as const, mimeType, data: bytes.toString("base64") },
  ],
});
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
// A group is a word a caller may send with `exec_command`, in the call's `_meta`, to put the
// session it starts among others it means to stop together. It is opaque, and names nobody.
const GROUP = "agentexec/group";
// The request that ends the running sessions of a group, and answers how many.
const STOP_GROUP = "agentexec/group/stop";
const Group = z.string().min(1).max(200);
const groupOf = (meta: Record<string, unknown> | undefined) => {
  const word = Group.optional().safeParse(meta?.[GROUP]);
  // Ignoring a word that isn't one would leave the session out of the group its caller meant.
  if (!word.success) throw new ExecRefused(`${GROUP} in _meta is a string of 1 to 200 characters.`);
  return word.data;
};
const YieldTime = z.number().int().positive().optional();
const MaxTokens = z.number().int().positive().optional();
const READ_ONLY = { readOnlyHint: true };
type Input = Record<string, unknown>;

/** AgentExec's own tools, at one level or another. */
export const TOOLS = [
  "exec_command",
  "write_stdin",
  "list_sessions",
  "read",
  "list",
  "search",
  "edit",
] as const;

/** How far an agent reaches, each level containing the one before. */
export const LEVELS = ["read", "files", "terminal"] as const;
export type Level = (typeof LEVELS)[number];

export function createServer(
  root: string,
  sessions: Sessions,
  version: string,
  level: Level,
  {
    extraTools = [],
    reach = "workspace",
    note,
  }: Partial<Pick<AgentExecOptions, "extraTools" | "reach" | "note">> = {},
) {
  const server = new McpServer({ name: "agentexec", version });
  if (note) {
    // Every tool registers through here, so each answer, a refusal or a picture among them, ends
    // with the host's line about the call where it has one. The SDK gives a tool with an input
    // schema its input first, and one without only the request's context. The host is asked
    // before the tool runs, and given a copy, so what it does to the input can't change the call.
    const register = server.registerTool.bind(server);
    server.registerTool = ((
      name: string,
      config: { inputSchema?: unknown },
      handler: (...args: unknown[]) => unknown,
    ) =>
      register(
        name,
        config as never,
        (async (...args: unknown[]) => {
          let line: unknown;
          try {
            line = note(name, config.inputSchema ? structuredClone(args[0] as Input) : {});
          } catch {
            // A note that fails is left out; the call is answered as it would be.
          }
          const answer = (await handler(...args)) as { content: unknown[] };
          return typeof line === "string" && line
            ? { ...answer, content: [...answer.content, text(line).content[0]] }
            : answer;
        }) as never,
      )) as typeof server.registerTool;
  }
  const at = resolver(root, reach);
  const files = createFiles(at);
  const where =
    reach === "machine"
      ? "Relative to the workspace, or absolute, anywhere on the machine."
      : "Inside the workspace; relative to it, or absolute.";
  const orWorkspace = `${where} The workspace by default.`;
  for (const { name, description, readOnly, call } of extraTools)
    server.registerTool(
      name,
      { description, ...(readOnly ? { annotations: READ_ONLY } : {}) },
      async () => {
        try {
          return text(String(await call()));
        } catch (error) {
          return { isError: true, ...text(error instanceof Error ? error.message : String(error)) };
        }
      },
    );

  if (level === "terminal") {
    // Not a tool: it is for whatever calls the tools, not for the agent that asks for them.
    server.server.setRequestHandler(
      STOP_GROUP,
      { params: z.object({ group: Group }), result: z.object({ stopped: z.number() }) },
      async ({ group }) => ({ stopped: await sessions.stopGroup(group) }),
    );
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
      (input, ctx) =>
        answering(async () => sessions.exec({ ...input, group: groupOf(ctx.mcpReq._meta) })),
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
      description:
        "Reads a text file as numbered lines, or shows a PNG, JPEG, GIF or WebP of up to 3 MiB as an image; offset and limit are for text.",
      inputSchema: {
        path: z.string().min(1).describe(where),
        offset: z.number().int().positive().optional().describe("The first line, from 1."),
        limit: z.number().int().positive().optional().describe("How many lines; 2000 by default."),
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const read = await files.read(input);
        return typeof read === "string" ? text(read) : pictured(input.path, read);
      } catch (error) {
        return refused(error);
      }
    },
  );
  server.registerTool(
    "list",
    {
      description: "Lists a folder: folders end in /, and files give their size in bytes.",
      inputSchema: { path: z.string().optional().describe(orWorkspace) },
      annotations: READ_ONLY,
    },
    (input) => saying(() => files.list(input)),
  );
  server.registerTool(
    "search",
    {
      description: `Searches text files under a folder, as path:line:text, the path from the workspace${reach === "machine" ? ", or whole for a file outside it" : ""}. Skips what .gitignore ignores, .git and node_modules.`,
      inputSchema: {
        pattern: z.string().min(1).describe("Exact text, or a regular expression with regex."),
        path: z.string().optional().describe(`A folder or file. ${orWorkspace}`),
        regex: z.boolean().optional(),
        ignore_case: z.boolean().optional(),
        limit: z.number().int().positive().optional().describe("Most matches; 200 by default."),
      },
      annotations: READ_ONLY,
    },
    (input) => saying(() => search(root, at, input)),
  );
  if (level !== "read")
    server.registerTool(
      "edit",
      {
        description:
          "Replaces exact text in a file and answers with a unified diff. old_text must appear exactly once unless replace_all. An empty old_text creates a new file.",
        inputSchema: {
          path: z.string().min(1).describe(where),
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
