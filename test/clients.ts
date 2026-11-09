// The two MCP clients the suite runs against: the official TypeScript and Python SDKs.
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface Called {
  text: string;
  isError: boolean;
}
export interface McpClient {
  tools(): Promise<string[]>;
  call(tool: string, args: Record<string, unknown>): Promise<Called>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(here, "..", "..", "dist", "agentexec.js");
/** A plain shell and a home of the test's own, so nothing of this machine's profile runs. */
export const environment = (workspace: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: workspace,
  SHELL: "/bin/bash",
});

async function typescriptClient(workspace: string): Promise<McpClient> {
  const client = new Client({ name: "conformance", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, "--workspace", workspace],
      env: environment(workspace),
    }),
  );
  return {
    tools: async () => (await client.listTools()).tools.map((tool) => tool.name),
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = result.content.map((block) => block.text ?? "").join("");
      return { text, isError: result.isError === true };
    },
    close: () => client.close(),
  };
}

async function pythonClient(workspace: string): Promise<McpClient> {
  const child: ChildProcess = spawn(
    process.env.AGENTEXEC_PYTHON ?? "python3",
    [
      join(here, "..", "..", "test", "python_client.py"),
      process.execPath,
      SERVER,
      "--workspace",
      workspace,
    ],
    { env: environment(workspace), stdio: ["pipe", "pipe", "inherit"] },
  );
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
  let id = 0;
  const ready = new Promise<void>((done, failed) => {
    child.once("exit", (code) => failed(new Error(`The Python client exited ${code}.`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const reply = JSON.parse(line) as Record<string, unknown>;
      if (reply.ready) done();
      else waiting.get(reply.id as number)?.(reply);
    });
  });
  await ready;
  const ask = (request: object) =>
    new Promise<Record<string, unknown>>((done) => {
      waiting.set(++id, done);
      child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  return {
    tools: async () => (await ask({ list: true })).tools as string[],
    async call(tool, args) {
      const reply = await ask({ tool, args });
      return { text: reply.text as string, isError: reply.isError as boolean };
    },
    close: () =>
      new Promise<void>((done) => {
        child.removeAllListeners("exit");
        child.once("exit", () => done());
        child.stdin?.end();
      }),
  };
}

export const CLIENTS = { typescript: typescriptClient, python: pythonClient };
