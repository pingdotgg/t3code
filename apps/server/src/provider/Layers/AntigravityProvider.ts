// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  showInteractionModeToggle: false,
} as const;

export const DEFAULT_ANTIGRAVITY_AGENTAPI_PATH = "~/.gemini/antigravity/bin/agentapi";
export const DEFAULT_ANTIGRAVITY_BRAIN_PATH = "~/.gemini/antigravity/brain";
export const DEFAULT_ANTIGRAVITY_SETTINGS_PATH = "~/.gemini/antigravity-cli/settings.json";
export const DEFAULT_ANTIGRAVITY_PROJECTS_PATH = "~/.gemini/config/projects";

const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CURRENT_ANTIGRAVITY_MODEL_LABELS = [
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.1 Pro (High)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
] as const;

const ANTIGRAVITY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  flash_lite: "Gemini 3.5 Flash (Low)",
  flash: "Gemini 3.5 Flash (Medium)",
  pro: "Gemini 3.1 Pro (High)",
};

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  thinking: "Thinking",
};

const REASONING_EFFORT_ORDER: ReadonlyArray<string> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "thinking",
];

interface AntigravityModelLabelParts {
  readonly baseName: string;
  readonly reasoningEffort?: string;
}

function normalizeReasoningEffort(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function reasoningEffortLabel(value: string): string {
  return (
    REASONING_EFFORT_LABELS[value] ??
    value
      .split("-")
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

function sortReasoningEfforts(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...values].sort((left, right) => {
    const leftIndex = REASONING_EFFORT_ORDER.indexOf(left);
    const rightIndex = REASONING_EFFORT_ORDER.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (
        (leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER) -
        (rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER)
      );
    }
    return left.localeCompare(right);
  });
}

export function parseAntigravityModelLabel(label: string): AntigravityModelLabelParts | undefined {
  const trimmed = label.trim();
  if (!trimmed) return undefined;

  const match = /^(?<base>.+?)\s+\((?<suffix>[^()]+)\)$/.exec(trimmed);
  if (!match?.groups) {
    return { baseName: trimmed };
  }

  const baseName = match.groups.base?.trim();
  const reasoningEffort = normalizeReasoningEffort(match.groups.suffix ?? "");
  if (!baseName) {
    return { baseName: trimmed };
  }
  if (!reasoningEffort || reasoningEffort === "fast") {
    return { baseName: trimmed };
  }

  return {
    baseName,
    reasoningEffort,
  };
}

export function formatAntigravityModelLabel(input: {
  readonly baseName: string;
  readonly reasoningEffort?: string | null;
}): string {
  const baseName = input.baseName.trim();
  const reasoningEffort = input.reasoningEffort
    ? normalizeReasoningEffort(input.reasoningEffort)
    : "";
  return reasoningEffort ? `${baseName} (${reasoningEffortLabel(reasoningEffort)})` : baseName;
}

function defaultReasoningEffortFor(efforts: ReadonlySet<string>): string | undefined {
  if (efforts.has("medium")) return "medium";
  if (efforts.has("high")) return "high";
  if (efforts.has("thinking")) return "thinking";
  return sortReasoningEfforts([...efforts])[0];
}

function antigravityModelCapabilities(
  reasoningEfforts: ReadonlySet<string>,
  defaultReasoningEffort: string | undefined,
): ModelCapabilities {
  if (reasoningEfforts.size === 0) {
    return DEFAULT_MODEL_CAPABILITIES;
  }

  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: sortReasoningEfforts([...reasoningEfforts]).map((effort) =>
          effort === defaultReasoningEffort
            ? { id: effort, label: reasoningEffortLabel(effort), isDefault: true }
            : { id: effort, label: reasoningEffortLabel(effort) },
        ),
        ...(defaultReasoningEffort ? { currentValue: defaultReasoningEffort } : {}),
      },
    ],
  });
}

export function buildAntigravityProviderModels(input: {
  readonly labels: ReadonlyArray<string>;
  readonly customLabels?: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const groups = new Map<
    string,
    {
      readonly baseName: string;
      readonly reasoningEfforts: Set<string>;
      isCustom: boolean;
    }
  >();

  const add = (label: string, isCustom: boolean) => {
    const mapped = ANTIGRAVITY_MODEL_ALIASES[label.trim()] ?? label;
    const parsed = parseAntigravityModelLabel(mapped);
    if (!parsed) return;

    const existing = groups.get(parsed.baseName);
    if (existing) {
      if (parsed.reasoningEffort) existing.reasoningEfforts.add(parsed.reasoningEffort);
      existing.isCustom = existing.isCustom && isCustom;
      return;
    }

    groups.set(parsed.baseName, {
      baseName: parsed.baseName,
      reasoningEfforts: new Set(parsed.reasoningEffort ? [parsed.reasoningEffort] : []),
      isCustom,
    });
  };

  for (const label of input.labels) add(label, false);
  for (const label of input.customLabels ?? []) add(label, true);

  return [...groups.values()].map((group) => {
    const defaultReasoningEffort = defaultReasoningEffortFor(group.reasoningEfforts);
    return {
      slug: formatAntigravityModelLabel(
        defaultReasoningEffort
          ? {
              baseName: group.baseName,
              reasoningEffort: defaultReasoningEffort,
            }
          : { baseName: group.baseName },
      ),
      name: group.baseName,
      isCustom: group.isCustom,
      capabilities: antigravityModelCapabilities(group.reasoningEfforts, defaultReasoningEffort),
    };
  });
}

function readAntigravityConfiguredModelLabels(
  settings: AntigravitySettings,
): ReadonlyArray<string> {
  const labels: string[] = [];

  try {
    const parsed = JSON.parse(
      readFileSync(resolveAntigravitySettingsPath(settings), "utf8"),
    ) as unknown;
    const model =
      parsed && typeof parsed === "object"
        ? (parsed as { readonly model?: unknown }).model
        : undefined;
    if (typeof model === "string") labels.push(model);
  } catch {
    // Settings may not exist until Antigravity has completed onboarding.
  }

  try {
    const logDir = nodePath.join(nodePath.dirname(resolveAntigravitySettingsPath(settings)), "log");
    for (const entry of readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .slice(-20)) {
      const contents = readFileSync(nodePath.join(logDir, entry), "utf8");
      for (const match of contents.matchAll(/label="([^"]+)"/g)) {
        if (match[1]) labels.push(match[1]);
      }
    }
  } catch {
    // Logs are opportunistic; built-in labels still keep the provider usable.
  }

  return labels;
}

export function resolveAntigravityModelLabel(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const rawModel = modelSelection?.model?.trim();
  if (!rawModel) return undefined;

  const mapped = ANTIGRAVITY_MODEL_ALIASES[rawModel] ?? rawModel;
  const parsed = parseAntigravityModelLabel(mapped);
  if (!parsed) return undefined;

  const selectedReasoning = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  const reasoningEffort = selectedReasoning ?? parsed.reasoningEffort;
  return formatAntigravityModelLabel(
    reasoningEffort
      ? {
          baseName: parsed.baseName,
          reasoningEffort,
        }
      : { baseName: parsed.baseName },
  );
}

function antigravityProviderModels(
  settings: AntigravitySettings,
): ReadonlyArray<ServerProviderModel> {
  return buildAntigravityProviderModels({
    labels: [
      ...CURRENT_ANTIGRAVITY_MODEL_LABELS,
      ...readAntigravityConfiguredModelLabels(settings),
    ],
    customLabels: settings.customModels,
  });
}

export function resolveAntigravityAgentApiPath(settings: AntigravitySettings): string {
  if (!settings.binaryPath || settings.binaryPath === "agentapi") {
    return expandHomePath(DEFAULT_ANTIGRAVITY_AGENTAPI_PATH);
  }
  return expandHomePath(settings.binaryPath);
}

export function resolveAntigravityBrainPath(settings: AntigravitySettings): string {
  return expandHomePath(settings.brainPath || DEFAULT_ANTIGRAVITY_BRAIN_PATH);
}

export function resolveAntigravitySettingsPath(settings: AntigravitySettings): string {
  return expandHomePath(settings.settingsPath || DEFAULT_ANTIGRAVITY_SETTINGS_PATH);
}

interface AntigravityDaemonCandidate {
  readonly address: string;
  readonly csrfToken: string | undefined;
}

export function parseAntigravityLanguageServerCmdline(
  cmdline: ReadonlyArray<string>,
): { readonly csrfToken: string | undefined } | undefined {
  const executable = cmdline[0] ?? "";
  if (!executable.includes("language_server") && !cmdline.includes("language_server")) {
    return undefined;
  }

  const csrfTokenIndex = cmdline.indexOf("--csrf_token");
  return {
    csrfToken: csrfTokenIndex >= 0 ? cmdline[csrfTokenIndex + 1] : undefined,
  };
}

export function parseLinuxTcpListenPortsForInodes(
  contents: string,
  socketInodes: ReadonlySet<string>,
): ReadonlyArray<number> {
  const ports: Array<number> = [];
  for (const line of contents.split(/\r?\n/g).slice(1)) {
    const columns = line.trim().split(/\s+/g);
    const localAddress = columns[1];
    const state = columns[3];
    const inode = columns[9];
    if (!localAddress || state !== "0A" || !inode || !socketInodes.has(inode)) {
      continue;
    }

    const [hostHex, portHex] = localAddress.split(":");
    if (!hostHex || !portHex) {
      continue;
    }

    const isLoopback =
      hostHex === "0100007F" ||
      hostHex === "00000000000000000000000001000000" ||
      hostHex === "00000000000000000000000000000001";
    if (!isLoopback) {
      continue;
    }

    const port = Number.parseInt(portHex, 16);
    if (Number.isFinite(port)) {
      ports.push(port);
    }
  }

  return [...new Set(ports)].sort((left, right) => left - right);
}

function readProcCmdline(pid: string): ReadonlyArray<string> {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function readSocketInodesForPid(pid: string): ReadonlySet<string> {
  const inodes = new Set<string>();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1]) {
        inodes.add(match[1]);
      }
    }
  } catch {
    // The daemon can exit while scanning /proc.
  }
  return inodes;
}

function readListenPortsForPid(pid: string): ReadonlyArray<number> {
  const socketInodes = readSocketInodesForPid(pid);
  if (socketInodes.size === 0) {
    return [];
  }

  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const port of parseLinuxTcpListenPortsForInodes(
        readFileSync(table, "utf8"),
        socketInodes,
      )) {
        ports.add(port);
      }
    } catch {
      // Some kernels or containers may not expose both tables.
    }
  }
  return [...ports].sort((left, right) => left - right);
}

function isUsableAntigravityDaemonCandidate(input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly candidate: AntigravityDaemonCandidate;
}): boolean {
  try {
    const output = execFileSync(input.binaryPath, ["get-conversation-metadata", "__t3_probe__"], {
      env: {
        ...input.environment,
        ANTIGRAVITY_LS_ADDRESS: input.candidate.address,
        ...(input.candidate.csrfToken ? { ANTIGRAVITY_CSRF_TOKEN: input.candidate.csrfToken } : {}),
      },
      timeout: 2_000,
      windowsHide: true,
      encoding: "utf8",
    });
    return output.includes("trajectory not found: __t3_probe__");
  } catch (cause) {
    const output =
      cause && typeof cause === "object" && "stdout" in cause
        ? String((cause as { readonly stdout?: unknown }).stdout ?? "")
        : "";
    const errorOutput =
      cause && typeof cause === "object" && "stderr" in cause
        ? String((cause as { readonly stderr?: unknown }).stderr ?? "")
        : "";
    return `${output}\n${errorOutput}`.includes("trajectory not found: __t3_probe__");
  }
}

export function detectAntigravityDaemonEnvironment(
  binaryPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Partial<Pick<NodeJS.ProcessEnv, "ANTIGRAVITY_LS_ADDRESS" | "ANTIGRAVITY_CSRF_TOKEN">> {
  if (environment.ANTIGRAVITY_LS_ADDRESS) {
    return {
      ANTIGRAVITY_LS_ADDRESS: environment.ANTIGRAVITY_LS_ADDRESS,
      ...(environment.ANTIGRAVITY_CSRF_TOKEN
        ? { ANTIGRAVITY_CSRF_TOKEN: environment.ANTIGRAVITY_CSRF_TOKEN }
        : {}),
    };
  }

  if (process.platform !== "linux") {
    return {};
  }

  const candidates: Array<AntigravityDaemonCandidate> = [];
  for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    const processInfo = parseAntigravityLanguageServerCmdline(readProcCmdline(pid));
    if (!processInfo) {
      continue;
    }

    for (const port of readListenPortsForPid(pid)) {
      candidates.push({
        address: `http://127.0.0.1:${port}`,
        csrfToken: processInfo.csrfToken,
      });
    }
  }

  const usable =
    candidates.find((candidate) =>
      isUsableAntigravityDaemonCandidate({ binaryPath, environment, candidate }),
    ) ?? candidates[0];

  return usable
    ? {
        ANTIGRAVITY_LS_ADDRESS: usable.address,
        ...(usable.csrfToken ? { ANTIGRAVITY_CSRF_TOKEN: usable.csrfToken } : {}),
      }
    : {};
}

function projectResourceFolder(resource: unknown): string | undefined {
  if (!resource || typeof resource !== "object") {
    return undefined;
  }

  const directFolder = (resource as { readonly folderUri?: unknown }).folderUri;
  if (typeof directFolder === "string") {
    return directFolder;
  }

  const gitFolder = (resource as { readonly gitFolder?: unknown }).gitFolder;
  if (gitFolder && typeof gitFolder === "object") {
    const gitFolderUri = (gitFolder as { readonly folderUri?: unknown }).folderUri;
    if (typeof gitFolderUri === "string") {
      return gitFolderUri;
    }
  }

  return undefined;
}

function fileUriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

export function detectAntigravityProjectIdForCwd(cwd: string): string | undefined {
  const projectsPath = expandHomePath(DEFAULT_ANTIGRAVITY_PROJECTS_PATH);
  const normalizedCwd = nodePath.resolve(cwd);
  const matches: Array<{ readonly projectId: string; readonly folder: string }> = [];

  try {
    for (const entry of readdirSync(projectsPath)) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      const parsed = JSON.parse(
        readFileSync(nodePath.join(projectsPath, entry), "utf8"),
      ) as unknown;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const projectId = (parsed as { readonly id?: unknown }).id;
      if (typeof projectId !== "string" || !projectId) {
        continue;
      }

      const resources = (
        parsed as {
          readonly projectResources?: { readonly resources?: unknown };
        }
      ).projectResources?.resources;
      if (!Array.isArray(resources)) {
        continue;
      }

      for (const resource of resources) {
        const folderUri = projectResourceFolder(resource);
        const folder = folderUri ? fileUriToPath(folderUri) : undefined;
        if (!folder) {
          continue;
        }

        const normalizedFolder = nodePath.resolve(folder);
        if (
          normalizedCwd === normalizedFolder ||
          normalizedCwd.startsWith(`${normalizedFolder}${nodePath.sep}`)
        ) {
          matches.push({ projectId, folder: normalizedFolder });
        }
      }
    }
  } catch {
    return undefined;
  }

  return matches.sort((left, right) => right.folder.length - left.folder.length)[0]?.projectId;
}

export function makeAntigravityEnvironment(
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): NodeJS.ProcessEnv {
  const detected = detectAntigravityDaemonEnvironment(
    resolveAntigravityAgentApiPath(settings),
    environment,
  );
  const projectId =
    environment.ANTIGRAVITY_PROJECT_ID ?? (cwd ? detectAntigravityProjectIdForCwd(cwd) : undefined);
  return {
    ...environment,
    ...detected,
    ...(projectId ? { ANTIGRAVITY_PROJECT_ID: projectId } : {}),
    ...(settings.languageServerAddress
      ? { ANTIGRAVITY_LS_ADDRESS: settings.languageServerAddress }
      : {}),
    ...(settings.csrfToken ? { ANTIGRAVITY_CSRF_TOKEN: settings.csrfToken } : {}),
  };
}

export function transcriptPathForConversation(input: {
  readonly settings: AntigravitySettings;
  readonly conversationId: string;
}): string {
  return `${resolveAntigravityBrainPath(input.settings)}/${input.conversationId}/.system_generated/logs/transcript.jsonl`;
}

export interface AntigravityDaemonEndpoint {
  readonly address: string;
  readonly csrfToken: string | undefined;
}

export function resolveAntigravityDaemonEndpoint(
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): AntigravityDaemonEndpoint | undefined {
  const env = makeAntigravityEnvironment(settings, environment, cwd);
  return env.ANTIGRAVITY_LS_ADDRESS
    ? { address: env.ANTIGRAVITY_LS_ADDRESS, csrfToken: env.ANTIGRAVITY_CSRF_TOKEN }
    : undefined;
}

export async function antigravityLanguageServerRpc(input: {
  readonly endpoint: AntigravityDaemonEndpoint;
  readonly method: string;
  readonly body: unknown;
}): Promise<unknown> {
  const response = await fetch(
    `${input.endpoint.address}/exa.language_server_pb.LanguageServerService/${input.method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.endpoint.csrfToken ? { "x-codeium-csrf-token": input.endpoint.csrfToken } : {}),
      },
      body: JSON.stringify(input.body),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${input.method} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const binaryPath = resolveAntigravityAgentApiPath(settings);
    const env = makeAntigravityEnvironment(settings, environment);
    const command = ChildProcess.make(binaryPath, ["get-conversation-metadata", "__t3_probe__"], {
      env,
      shell: process.platform === "win32",
    });

    const result = yield* spawnAndCollect(binaryPath, command).pipe(
      Effect.timeoutOption(4_000),
      Effect.result,
    );

    const probe = (() => {
      if (Result.isFailure(result)) {
        const error = result.failure;
        if (isCommandMissingCause(error)) {
          return {
            installed: false,
            version: null,
            status: "error" as const,
            auth: { status: "unknown" as const, label: "Antigravity daemon" },
            message:
              "Antigravity agentapi is not installed or the configured binary path is incorrect.",
          };
        }
        return {
          installed: true,
          version: null,
          status: "error" as const,
          auth: { status: "unknown" as const, label: "Antigravity daemon" },
          message: error.message,
        };
      }

      if (Option.isNone(result.success)) {
        return {
          installed: true,
          version: null,
          status: "warning" as const,
          auth: { status: "unknown" as const, label: "Antigravity daemon" },
          message: "Timed out while checking Antigravity agentapi.",
        };
      }

      const commandResult = result.success.value;
      const detail = detailFromResult(commandResult);
      const output = `${commandResult.stdout}\n${commandResult.stderr}`;
      const version = parseGenericCliVersion(output);
      const daemonReachable = output.includes("trajectory not found: __t3_probe__");
      if (commandResult.code !== 0) {
        return {
          installed: true,
          version,
          status: daemonReachable ? ("ready" as const) : ("warning" as const),
          auth: {
            status: daemonReachable ? ("authenticated" as const) : ("unknown" as const),
            label: "Antigravity daemon",
          },
          ...(detail && !daemonReachable ? { message: detail } : {}),
        };
      }
      return {
        installed: true,
        version,
        status: "ready" as const,
        auth: { status: "authenticated" as const, type: "oauth", label: "Google Antigravity" },
      };
    })();

    return buildServerProvider({
      driver: PROVIDER,
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: antigravityProviderModels(settings),
      probe,
    });
  },
);

export const makePendingAntigravityProvider = Effect.fn("makePendingAntigravityProvider")(
  function* (settings: AntigravitySettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      driver: PROVIDER,
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: antigravityProviderModels(settings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown", label: "Antigravity daemon" },
      },
    });
  },
);
