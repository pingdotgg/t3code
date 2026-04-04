import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import type { FileAdapter } from "../adapters/file-adapter.ts";
import type { FileChange, ToolUse } from "../types.ts";

export interface ToolResult {
  toolUseId: string;
  content: string;
}

export type CommandApprovalFn = (
  command: string,
  description: string,
) => Promise<boolean>;

/**
 * Handles tool calls from Claude.
 * - read_file / list_directory: execute immediately
 * - write_file / delete_file / move_file: queued for diff review
 * - run_command: pauses for explicit user approval, then executes
 */
export class ToolHandler {
  constructor(
    private readonly fileAdapter: FileAdapter,
    private readonly queueChange: (change: FileChange) => void,
    private readonly requestCommandApproval: CommandApprovalFn,
  ) {}

  async handle(toolUse: ToolUse): Promise<ToolResult> {
    const content = await this.#dispatch(toolUse);
    return { toolUseId: toolUse.id, content };
  }

  async #dispatch(toolUse: ToolUse): Promise<string> {
    switch (toolUse.name) {
      case "read_file":
        return this.#readFile(toolUse.input);
      case "write_file":
        return this.#writeFile(toolUse.input);
      case "list_directory":
        return this.#listDirectory(toolUse.input);
      case "delete_file":
        return this.#deleteFile(toolUse.input);
      case "move_file":
        return this.#moveFile(toolUse.input);
      case "run_command":
        return this.#runCommand(toolUse.input);
      default:
        throw new Error(`Unknown tool: ${toolUse.name}`);
    }
  }

  async #readFile(input: Record<string, unknown>): Promise<string> {
    const path = String(input["path"] ?? "");
    try {
      return await this.fileAdapter.read(path);
    } catch {
      return `Error: could not read "${path}"`;
    }
  }

  async #writeFile(input: Record<string, unknown>): Promise<string> {
    const path = String(input["path"] ?? "");
    const content = String(input["content"] ?? "");

    let originalContent: string | undefined;
    try {
      originalContent = await this.fileAdapter.read(path);
    } catch {
      originalContent = undefined;
    }

    this.queueChange(
      originalContent !== undefined
        ? { type: "modify", path, originalContent, newContent: content }
        : { type: "create", path, newContent: content },
    );

    return `Queued: ${originalContent !== undefined ? "modify" : "create"} "${path}"`;
  }

  async #listDirectory(input: Record<string, unknown>): Promise<string> {
    const path = String(input["path"] ?? ".");
    try {
      const entries = await this.fileAdapter.listDirectory(path);
      return entries
        .map((e) => `${e.isDirectory ? "d" : "f"}  ${e.path}`)
        .join("\n");
    } catch {
      return `Error: could not list "${path}"`;
    }
  }

  async #deleteFile(input: Record<string, unknown>): Promise<string> {
    const path = String(input["path"] ?? "");
    let originalContent: string | undefined;
    try {
      originalContent = await this.fileAdapter.read(path);
    } catch {
      return `Error: file not found "${path}"`;
    }

    this.queueChange({ type: "delete", path, originalContent });
    return `Queued: delete "${path}"`;
  }

  async #moveFile(input: Record<string, unknown>): Promise<string> {
    const source = String(input["source"] ?? "");
    const destination = String(input["destination"] ?? "");

    let originalContent: string | undefined;
    try {
      originalContent = await this.fileAdapter.read(source);
    } catch {
      return `Error: source file not found "${source}"`;
    }

    this.queueChange({
      type: "move",
      path: source,
      destPath: destination,
      originalContent,
      newContent: originalContent,
    });
    return `Queued: move "${source}" → "${destination}"`;
  }

  async #runCommand(input: Record<string, unknown>): Promise<string> {
    const command = String(input["command"] ?? "");
    const description = String(input["description"] ?? "");

    const approved = await this.requestCommandApproval(command, description);
    if (!approved) {
      return `Command rejected by user: ${command}`;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.fileAdapter.workingDir,
        timeout: 30_000,
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      return combined || "(command completed with no output)";
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      const detail = error.stderr ?? error.stdout ?? error.message ?? String(err);
      return `Command failed:\n${detail}`;
    }
  }
}
