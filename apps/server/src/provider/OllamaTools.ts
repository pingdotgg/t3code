// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { CanonicalItemType, CanonicalRequestType } from "@t3tools/contracts";
import type { OllamaToolDefinition, OllamaToolCall } from "./ollamaRuntime.js";

// ── Error ──────────────────────────────────────────────────────────────

export class OllamaToolError extends Data.TaggedError("OllamaToolError")<{
  readonly toolName: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

// ── Tool definitions ───────────────────────────────────────────────────

export const OLLAMA_TOOL_DEFINITIONS: readonly OllamaToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content as text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read." },
          offset: { type: "integer", description: "Line number to start reading from (1-based, optional)." },
          limit: { type: "integer", description: "Maximum number of lines to read (optional)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to write." },
          content: { type: "string", description: "Content to write to the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command and return its output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          cwd: { type: "string", description: "Working directory for the command (optional)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the files and directories inside a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to list." },
          recursive: { type: "boolean", description: "List recursively (optional, default false)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a pattern in files using grep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or literal pattern to search for." },
          path: { type: "string", description: "Directory to search in (optional, defaults to cwd)." },
          file_glob: { type: "string", description: "File glob pattern to filter files (optional, e.g. '*.ts')." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit a file by replacing an exact string with a new string. Use this for targeted edits rather than rewriting the whole file. Fails if old_string is not found or appears more than once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit." },
          old_string: { type: "string", description: "Exact string to replace (must appear exactly once in the file)." },
          new_string: { type: "string", description: "Replacement string." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch the content of a URL and return it as text. Useful for reading documentation, GitHub files, or any public web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch." },
          max_length: { type: "integer", description: "Maximum number of characters to return (optional, default 20000)." },
        },
        required: ["url"],
      },
    },
  },
] as const;

// ── Classification ─────────────────────────────────────────────────────

export function classifyOllamaToolItemType(toolName: string): CanonicalItemType {
  if (toolName === "bash") return "command_execution";
  if (toolName === "write_file" || toolName === "edit_file") return "file_change";
  return "dynamic_tool_call";
}

export function classifyOllamaRequestType(toolName: string): CanonicalRequestType {
  if (toolName === "bash") return "command_execution_approval";
  if (toolName === "write_file" || toolName === "edit_file") return "file_change_approval";
  if (toolName === "read_file") return "file_read_approval";
  return "dynamic_tool_call";
}

export function summarizeOllamaToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file": return `Read file: ${args.path}`;
    case "write_file": return `Write file: ${args.path}`;
    case "edit_file": return `Edit file: ${args.path}`;
    case "bash": return `Run: ${args.command}`;
    case "list_directory": return `List directory: ${args.path}`;
    case "search_files": return `Search "${args.pattern}"${args.path ? ` in ${args.path}` : ""}`;
    case "web_fetch": return `Fetch: ${args.url}`;
    default: return `Tool call: ${toolName}`;
  }
}

// ── Execution ──────────────────────────────────────────────────────────

function listDirRecursive(dirPath: string, prefix = ""): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory()) {
      lines.push(...listDirRecursive(path.join(dirPath, entry.name), `${prefix}${entry.name}/`));
    }
  }
  return lines;
}

export const executeOllamaTool = (
  call: OllamaToolCall,
  cwd: string,
): Effect.Effect<string, OllamaToolError> => {
  const name = call.function.name;
  const args = call.function.arguments;

  if (name === "web_fetch") {
    const url = String(args.url);
    const maxLength = typeof args.max_length === "number" ? args.max_length : 20_000;
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; T3Code/1.0)" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const text = await response.text();
        // Strip HTML tags for readability when content looks like HTML
        const stripped = text.includes("</") ? text.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim() : text;
        return stripped.length > maxLength ? stripped.slice(0, maxLength) + "\n…(truncated)" : stripped;
      },
      catch: (cause) => new OllamaToolError({ toolName: name, detail: cause instanceof Error ? cause.message : String(cause), cause }),
    });
  }

  return Effect.try({
    try: () => {

      if (name === "read_file") {
        const filePath = path.resolve(cwd, String(args.path));
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n");
        const offset = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
        const limit = typeof args.limit === "number" ? args.limit : lines.length;
        return lines.slice(offset, offset + limit).join("\n");
      }

      if (name === "write_file") {
        const filePath = path.resolve(cwd, String(args.path));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, String(args.content ?? ""), "utf8");
        return `Wrote ${filePath}`;
      }

      if (name === "bash") {
        // spawnSync with shell:true is intentional here — the bash tool is a
        // deliberate shell executor. User must approve via the approval flow
        // before this code runs, so the command is safe-by-consent.
        const result = spawnSync(String(args.command), [], {
          cwd: args.cwd ? String(args.cwd) : cwd,
          encoding: "utf8",
          shell: true,
          timeout: 30_000,
        });
        if (result.error) throw result.error;
        const out = (result.stdout ?? "") + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
        return out || `(exit code ${result.status ?? 0})`;
      }

      if (name === "list_directory") {
        const dirPath = path.resolve(cwd, String(args.path));
        const recursive = args.recursive === true;
        if (recursive) {
          return listDirRecursive(dirPath).join("\n");
        }
        return fs.readdirSync(dirPath).join("\n");
      }

      if (name === "search_files") {
        const searchPath = args.path ? path.resolve(cwd, String(args.path)) : cwd;
        const grepArgs: string[] = ["-r", "-n"];
        if (args.file_glob) grepArgs.push("--include", String(args.file_glob));
        grepArgs.push(String(args.pattern), searchPath);
        const result = spawnSync("grep", grepArgs, {
          cwd,
          encoding: "utf8",
          timeout: 15_000,
        });
        if (result.error) throw result.error;
        // grep exits with status 1 when no matches — not an error
        if (result.status === 1) return "(no matches)";
        if (result.status !== 0) throw new Error(`grep exited with status ${result.status}: ${result.stderr}`);
        return result.stdout || "(no matches)";
      }

      if (name === "edit_file") {
        const filePath = path.resolve(cwd, String(args.path));
        const content = fs.readFileSync(filePath, "utf8");
        const oldStr = String(args.old_string);
        const newStr = String(args.new_string);
        const count = content.split(oldStr).length - 1;
        if (count === 0) throw new Error(`old_string not found in ${args.path}`);
        if (count > 1) throw new Error(`old_string found ${count} times in ${args.path} — be more specific`);
        fs.writeFileSync(filePath, content.replace(oldStr, newStr), "utf8");
        return `Edited ${filePath}`;
      }

      return `Unknown tool: ${name}`;
    },
    catch: (cause) =>
      new OllamaToolError({
        toolName: name,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
};
