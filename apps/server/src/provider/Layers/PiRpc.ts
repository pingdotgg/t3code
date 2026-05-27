// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { homedir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";

export interface PiRpcModel {
  readonly id: string;
  readonly name?: string | undefined;
  readonly provider?: string | undefined;
  readonly reasoning?: boolean | undefined;
  readonly input?: ReadonlyArray<string> | undefined;
}

export interface PiRpcSlashCommand {
  readonly name: string;
  readonly description?: string | undefined;
  readonly source?: string | undefined;
}

export interface PiLocalSettings {
  readonly defaultProvider?: string | undefined;
  readonly defaultModel?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly enabledModels?: ReadonlyArray<string> | undefined;
}

export interface PiRpcLine {
  readonly type?: string | undefined;
  readonly id?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly command?: string | undefined;
  readonly success?: boolean | undefined;
  readonly data?: unknown;
  readonly error?: string | undefined;
  readonly message?: unknown;
  readonly assistantMessageEvent?: unknown;
  readonly messages?: unknown;
}

export interface PiRpcCommand {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiRpcRunResult {
  readonly responses: ReadonlyMap<string, PiRpcLine>;
  readonly events: ReadonlyArray<PiRpcLine>;
  readonly stderr: string;
}

export interface PiPromptResult {
  readonly text: string;
  readonly events: ReadonlyArray<PiRpcLine>;
  readonly stderr: string;
}

export type PiRpcEventHandler = (event: PiRpcLine) => void;

export function piAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export async function readPiLocalSettings(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PiLocalSettings> {
  const settingsPath = join(piAgentDir(environment), "settings.json");
  const raw = await readFile(settingsPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    defaultProvider:
      typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined,
    defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined,
    defaultThinkingLevel:
      typeof parsed.defaultThinkingLevel === "string" ? parsed.defaultThinkingLevel : undefined,
    enabledModels: Array.isArray(parsed.enabledModels)
      ? parsed.enabledModels.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

export async function runPiCommand(input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, [...input.args], {
      cwd: input.cwd,
      env: input.environment ?? process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Timed out running ${input.binaryPath} ${input.args.join(" ")}`));
    }, input.timeoutMs ?? 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

export async function runPiRpcCommands(input: {
  readonly binaryPath: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly commands: ReadonlyArray<PiRpcCommand>;
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly waitForAgentEnd?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: PiRpcEventHandler | undefined;
}): Promise<PiRpcRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, ["--mode", "rpc", ...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.environment ?? process.env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = new Map<string, PiRpcLine>();
    const pending = new Set(input.commands.map((command) => command.id));
    const events: PiRpcLine[] = [];
    let stderr = "";
    let stdoutBuffer = "";
    let agentEnded = false;
    let requestedClose = false;
    let settled = false;

    const finishIfReady = () => {
      if (pending.size > 0) return;
      if (input.waitForAgentEnd === true && !agentEnded) return;
      if (requestedClose) return;
      requestedClose = true;
      child.stdin.end();
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };

    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(() => {
      rejectOnce(new Error(`Timed out waiting for Pi RPC. Stderr: ${stderr.trim()}`));
    }, input.timeoutMs ?? 120_000);

    input.signal?.addEventListener("abort", () => {
      rejectOnce(new Error("Pi RPC request was aborted."));
    });

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: PiRpcLine;
      try {
        parsed = JSON.parse(line) as PiRpcLine;
      } catch {
        events.push({ type: "parse_error", message: line });
        return;
      }

      if (parsed.type === "response" && parsed.id) {
        responses.set(parsed.id, parsed);
        pending.delete(parsed.id);
        if (parsed.success === false) {
          rejectOnce(
            new Error(
              typeof parsed.error === "string"
                ? parsed.error
                : `Pi RPC command '${parsed.command ?? parsed.id}' failed.`,
            ),
          );
          return;
        }
        finishIfReady();
        return;
      }

      events.push(parsed);
      input.onEvent?.(parsed);
      if (parsed.type === "agent_end") {
        agentEnded = true;
        finishIfReady();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      rejectOnce(error);
    });
    child.on("close", () => {
      if (settled) return;
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer.trim());
      }
      if (pending.size > 0) {
        rejectOnce(new Error(`Pi RPC exited before responses arrived. Stderr: ${stderr.trim()}`));
        return;
      }
      if (input.waitForAgentEnd === true && !agentEnded) {
        rejectOnce(new Error(`Pi RPC exited before agent_end. Stderr: ${stderr.trim()}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ responses, events, stderr });
    });

    for (const command of input.commands) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
    finishIfReady();
  });
}

export async function runPiRpcPrompt(input: {
  readonly binaryPath: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly message: string;
  readonly images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }> | undefined;
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: PiRpcEventHandler | undefined;
}): Promise<PiPromptResult> {
  const result = await runPiRpcCommands({
    binaryPath: input.binaryPath,
    args: input.args,
    commands: [
      {
        id: "prompt",
        type: "prompt",
        message: input.message,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      },
    ],
    cwd: input.cwd,
    environment: input.environment,
    timeoutMs: input.timeoutMs,
    waitForAgentEnd: true,
    signal: input.signal,
    onEvent: input.onEvent,
  });
  return {
    text: extractAssistantText(result.events),
    events: result.events,
    stderr: result.stderr,
  };
}

function readTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .join("");
}

function readAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return "";
  return readTextFromContent(record.content);
}

export function readPiAssistantTextDelta(event: PiRpcLine): string {
  if (event.type !== "message_update") return "";
  const assistantMessageEvent = event.assistantMessageEvent;
  if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return "";
  const record = assistantMessageEvent as Record<string, unknown>;
  if (record.type !== "text_delta") return "";
  return typeof record.delta === "string" ? record.delta : "";
}

export function extractAssistantText(events: ReadonlyArray<PiRpcLine>): string {
  for (const event of events.toReversed()) {
    if (event.type !== "message_end") continue;
    const text = readAssistantText(event.message);
    if (text.trim().length > 0) return text;
  }

  for (const event of events.toReversed()) {
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    for (const candidate of event.messages.toReversed()) {
      const text = readAssistantText(candidate);
      if (text.trim().length > 0) return text;
    }
  }

  return events.map((event) => readPiAssistantTextDelta(event)).join("");
}

export function splitPiModelSlug(
  slug: string | undefined,
): { provider: string; modelId: string } | null {
  if (!slug) return null;
  const [provider, ...modelParts] = slug.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) return null;
  return { provider, modelId: modelId.split(":")[0] ?? modelId };
}
