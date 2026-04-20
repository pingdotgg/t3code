import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as FS from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ChatAttachment,
  ModelCapabilities,
  ProviderApprovalDecision,
  RuntimeMode,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";

const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
const DEFAULT_HOSTNAME = "127.0.0.1";

const OPENAI_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const ANTHROPIC_VARIANTS = ["high", "max"];
const GOOGLE_VARIANTS = ["low", "high"];

export const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly process: ChildProcess;
  close(): void;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly process: ChildProcess | null;
  readonly external: boolean;
  close(): void;
}

function buildOpenCodeBasicAuthorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

function isPrimaryAgent(agent: Agent): boolean {
  return !agent.hidden && (agent.mode === "primary" || agent.mode === "all");
}

function inferVariantValues(providerID: string): ReadonlyArray<string> {
  if (providerID === "anthropic") {
    return ANTHROPIC_VARIANTS;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return OPENAI_VARIANTS;
  }
  if (providerID.startsWith("google")) {
    return GOOGLE_VARIANTS;
  }
  return [];
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function buildVariantOptions(
  providerID: string,
  model: ProviderListResponse["all"][number]["models"][string],
) {
  const variantValues = Object.keys(model.variants ?? {});
  const resolvedValues =
    variantValues.length > 0 ? variantValues : [...inferVariantValues(providerID)];
  const defaultVariant = inferDefaultVariant(providerID, resolvedValues);

  return resolvedValues.map((value) => {
    const option: { value: string; label: string; isDefault?: boolean } = {
      value,
      label: titleCaseSlug(value),
    };
    if (defaultVariant === value) {
      option.isDefault = true;
    }
    return option;
  });
}

function buildAgentOptions(agents: ReadonlyArray<Agent>) {
  const primaryAgents = agents.filter(isPrimaryAgent);
  const defaultAgent =
    primaryAgents.find((agent) => agent.name === "build")?.name ??
    primaryAgents[0]?.name ??
    undefined;
  return primaryAgents.map((agent) => {
    const option: { value: string; label: string; isDefault?: boolean } = {
      value: agent.name,
      label: titleCaseSlug(agent.name),
    };
    if (defaultAgent === agent.name) {
      option.isDefault = true;
    }
    return option;
  });
}

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantOptions = buildVariantOptions(input.providerID, input.model);
  const agentOptions = buildAgentOptions(input.agents);
  return {
    ...DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    ...(variantOptions.length > 0 ? { variantOptions } : {}),
    ...(agentOptions.length > 0 ? { agentOptions } : {}),
  };
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function toOpenCodeModelSlug(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

export async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_HOSTNAME, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export function resolveOpenCodeBinaryPath(binaryPath: string): string {
  if (Path.isAbsolute(binaryPath)) {
    return binaryPath;
  }
  return execFileSync("which", [binaryPath], {
    encoding: "utf8",
    timeout: 3_000,
  }).trim();
}

export function detectMacosSigkillHint(binaryPath: string): string | null {
  try {
    // Check for quarantine xattr first.
    const resolvedPath = resolveOpenCodeBinaryPath(binaryPath);
    const xattr = execFileSync("xattr", ["-l", resolvedPath], {
      encoding: "utf8",
      timeout: 3_000,
    });
    if (xattr.includes("com.apple.quarantine")) {
      return (
        `macOS quarantine is blocking the OpenCode binary. ` +
        `Run: xattr -d com.apple.quarantine ${resolvedPath}`
      );
    }

    // Look for a recent crash report with the termination reason.
    const crashDir = Path.join(OS.homedir(), "Library/Logs/DiagnosticReports");
    const binaryName = Path.basename(resolvedPath);
    const recentReports = FS.readdirSync(crashDir)
      .filter((f) => f.startsWith(binaryName) && f.endsWith(".ips"))
      .toSorted()
      .toReversed()
      .slice(0, 1);

    for (const report of recentReports) {
      const content = FS.readFileSync(Path.join(crashDir, report), "utf8");
      if (content.includes('"namespace":"CODESIGNING"')) {
        return (
          "macOS killed the process due to an invalid code signature. " +
          "The binary may be corrupted — try reinstalling OpenCode."
        );
      }
    }
  } catch {
    // Best-effort detection — don't fail the original error path.
  }
  return null;
}

export async function startOpenCodeServerProcess(input: {
  readonly binaryPath: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly timeoutMs?: number;
}): Promise<OpenCodeServerProcess> {
  const hostname = input.hostname ?? DEFAULT_HOSTNAME;
  const port = input.port ?? (await findAvailablePort());
  const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
  const child = spawn(input.binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
    },
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    child.kill();
  };

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      close();
      reject(new Error(`Timed out waiting for OpenCode server start after ${timeoutMs}ms.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const onStdout = (chunk: string) => {
      stdout += chunk;
      const parsed = parseServerUrlFromOutput(stdout);
      if (!parsed) {
        return;
      }
      cleanup();
      resolve(parsed);
    };

    const onStderr = (chunk: string) => {
      stderr += chunk;
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const exitReason = signal ? `signal: ${signal}` : `code: ${code ?? "unknown"}`;
      const hint =
        signal === "SIGKILL" && process.platform === "darwin"
          ? detectMacosSigkillHint(input.binaryPath)
          : null;
      reject(
        new Error(
          [
            `OpenCode server exited before startup completed (${exitReason}).`,
            hint,
            stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
            stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });

  return {
    url,
    process: child,
    close,
  };
}

export async function connectToOpenCodeServer(input: {
  readonly binaryPath: string;
  readonly serverUrl?: string | null;
  readonly port?: number;
  readonly hostname?: string;
  readonly timeoutMs?: number;
}): Promise<OpenCodeServerConnection> {
  const serverUrl = input.serverUrl?.trim();
  if (serverUrl) {
    return {
      url: serverUrl,
      process: null,
      external: true,
      close() {},
    };
  }

  const server = await startOpenCodeServerProcess({
    binaryPath: input.binaryPath,
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  return {
    url: server.url,
    process: server.process,
    external: false,
    close: () => server.close(),
  };
}

export async function runOpenCodeCommand(input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
}): Promise<OpenCodeCommandResult> {
  const child = spawn(input.binaryPath, [...input.args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: process.env,
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  const stdoutChunks: Array<string> = [];
  const stderrChunks: Array<string> = [];

  child.stdout?.on("data", (chunk: string) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 0));
  });

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    code,
  };
}

export function createOpenCodeSdkClient(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
}): OpencodeClient {
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    directory: input.directory,
    ...(input.serverPassword
      ? {
          headers: {
            Authorization: buildOpenCodeBasicAuthorizationHeader(input.serverPassword),
          },
        }
      : {}),
    throwOnError: true,
  });
}

export async function loadOpenCodeInventory(client: OpencodeClient): Promise<OpenCodeInventory> {
  const [providerListResult, agentsResult] = await Promise.all([
    client.provider.list(),
    client.app.agents(),
  ]);
  if (!providerListResult.data) {
    throw new Error("OpenCode provider inventory was empty.");
  }
  return {
    providerList: providerListResult.data,
    agents: agentsResult.data ?? [],
  };
}

export function flattenOpenCodeModels(
  input: OpenCodeInventory,
): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      models.push({
        slug: toOpenCodeModelSlug(provider.id, model.id),
        name: model.name,
        subProvider: provider.name,
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}
