import type {
  PiSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const PI_FALLBACK_MODEL: ServerProviderModel = {
  slug: "pi-default",
  name: "Pi Default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};
const PI_OPENAI_CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.1",
].map((slug) => ({
  slug,
  name: formatPiModelName(slug),
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
}));
const PI_DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [PI_FALLBACK_MODEL];
const ABOUT_TIMEOUT_MS = 4_000;
const LOGIN_SHELL_TIMEOUT_MS = 2_000;

export interface PiConfigModelDefaults {
  readonly defaultModel: string | null;
  readonly defaultProvider: string | null;
  readonly malformed: boolean;
}

export interface PiAuthState {
  readonly status: "valid" | "expired" | "missing" | "unknown";
  readonly provider: string | null;
  readonly expiresAt: string | null;
}

export interface PiBinaryResolution {
  readonly binaryPath: string;
  readonly suggestedBinaryPath: string | null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parsePiConfigModelDefaults(raw: string): PiConfigModelDefaults {
  const jsonDefaultProvider = extractJsonStringField(raw, "defaultProvider");
  const jsonDefaultModel = extractJsonStringField(raw, "defaultModel");
  if (jsonDefaultModel?.trim()) {
    return {
      defaultModel: jsonDefaultModel.trim(),
      defaultProvider: jsonDefaultProvider?.trim() || null,
      malformed: false,
    };
  }

  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let inModelBlock = false;
  let modelIndent = 0;
  let sawModelBlock = false;

  for (const line of lines) {
    const withoutComment = line.replace(/\s+#.*$/, "");
    if (withoutComment.trim().length === 0) continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const trimmed = withoutComment.trim();
    const topLevelModelMatch = /^model\s*:\s*$/.exec(trimmed);
    if (topLevelModelMatch && indent === 0) {
      inModelBlock = true;
      sawModelBlock = true;
      modelIndent = indent;
      continue;
    }

    if (inModelBlock && indent <= modelIndent) {
      inModelBlock = false;
    }

    if (!inModelBlock) continue;
    const defaultMatch = /^default\s*:\s*(.+?)\s*$/.exec(trimmed);
    if (!defaultMatch?.[1]) continue;

    const value = stripQuotes(defaultMatch[1]);
    return {
      defaultModel: value.length > 0 ? value : null,
      defaultProvider: jsonDefaultProvider?.trim() || null,
      malformed: false,
    };
  }

  return {
    defaultModel: null,
    defaultProvider: jsonDefaultProvider?.trim() || null,
    malformed: sawModelBlock,
  };
}

function formatPiModelName(slug: string): string {
  return slug
    .split(/[/-]/g)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (/^gpt$/i.test(segment)) return "GPT";
      if (/^\d/.test(segment)) return segment;
      return segment[0]!.toUpperCase() + segment.slice(1);
    })
    .join(" ");
}

function modelFromPiDefault(defaultModel: string | null): ServerProviderModel {
  const slug = defaultModel?.trim();
  if (!slug) return PI_FALLBACK_MODEL;
  return {
    slug,
    name: formatPiModelName(slug),
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  };
}

function readPiConfigModelDefaults(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<PiConfigModelDefaults, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = environment.PI_CODING_AGENT_DIR?.trim()
      ? environment.PI_CODING_AGENT_DIR
      : path.join(environment.HOME || NodeOS.homedir(), ".pi", "agent");
    const raw = yield* fs
      .readFileString(path.join(home, "settings.json"))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return raw
      ? parsePiConfigModelDefaults(raw)
      : { defaultModel: null, defaultProvider: null, malformed: false };
  });
}

function extractJsonStringField(raw: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(raw);
  return match?.[1] ?? null;
}

function extractProviderObject(raw: string, provider: string): string | null {
  const keyIndex = raw.indexOf(`"${provider}"`);
  if (keyIndex < 0) return null;
  const objectStart = raw.indexOf("{", keyIndex);
  if (objectStart < 0) return null;
  let depth = 0;
  for (let index = objectStart; index < raw.length; index++) {
    const char = raw[index];
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return raw.slice(objectStart, index + 1);
    }
  }
  return null;
}

function extractJsonNumberField(raw: string, field: string): number | null {
  const match = new RegExp(`"${field}"\\s*:\\s*(\\d+)`).exec(raw);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readOptionalFile(
  path: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(null)));
  });
}

function readPiAuthState(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<PiAuthState, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = environment.PI_CODING_AGENT_DIR?.trim()
      ? environment.PI_CODING_AGENT_DIR
      : path.join(environment.HOME || NodeOS.homedir(), ".pi", "agent");
    const settings = yield* readOptionalFile(path.join(home, "settings.json"));
    const defaultProvider = settings
      ? (extractJsonStringField(settings, "defaultProvider") ?? "")
      : "";
    const provider = defaultProvider.length > 0 ? defaultProvider : null;
    const auth = yield* readOptionalFile(path.join(home, "auth.json"));
    if (!provider || !auth) {
      return { status: "unknown", provider, expiresAt: null };
    }

    const providerAuth = extractProviderObject(auth, provider);
    if (!providerAuth) {
      return { status: "missing", provider, expiresAt: null };
    }

    const expires = extractJsonNumberField(providerAuth, "expires");
    if (expires === null) {
      return { status: "unknown", provider, expiresAt: null };
    }

    const expiresMs = expires > 1_000_000_000_000 ? expires : expires * 1000;
    const nowMs = yield* Clock.currentTimeMillis;
    const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(expiresMs));
    return {
      status: nowMs >= expiresMs ? "expired" : "valid",
      provider,
      expiresAt,
    };
  });
}

function isExplicitBinaryPath(binaryPath: string): boolean {
  return binaryPath.includes("/") || binaryPath.includes("\\") || binaryPath.startsWith("~");
}

function commonPiBinaryCandidates(
  binaryName: "pi" | "pi-acp",
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ReadonlyArray<string>, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = environment.HOME || NodeOS.homedir();
    return [
      path.join(home, `.local/bin/${binaryName}`),
      path.join(home, `.npm-global/bin/${binaryName}`),
      `/opt/homebrew/bin/${binaryName}`,
      `/usr/local/bin/${binaryName}`,
    ];
  });
}

function expandHomePath(input: string, environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME || NodeOS.homedir();
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return `${home}${input.slice(1)}`;
  return input;
}

function firstExistingPath(
  candidates: ReadonlyArray<string>,
): Effect.Effect<string | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const candidate of candidates) {
      const exists = yield* fs.exists(candidate).pipe(Effect.catch(() => Effect.succeed(false)));
      if (exists) return candidate;
    }
    return null;
  });
}

function detectPiFromLoginShell(
  binaryName: "pi" | "pi-acp",
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> {
  const shell = environment.SHELL?.trim() || "/bin/zsh";
  return runRawCommand(shell, ["-lc", `command -v ${binaryName}`], environment).pipe(
    Effect.timeoutOption(LOGIN_SHELL_TIMEOUT_MS),
    Effect.map((result) => {
      if (Option.isNone(result) || result.value.code !== 0) return null;
      const candidate = result.value.stdout.trim().split(/\r?\n/u)[0]?.trim();
      return candidate && candidate.length > 0 ? candidate : null;
    }),
    Effect.catch(() => Effect.succeed(null)),
  );
}

export function resolvePiBinary(
  piSettings: Pick<PiSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  PiBinaryResolution,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const configured = piSettings.binaryPath.trim() || "pi-acp";
    const explicitConfigured = isExplicitBinaryPath(configured);
    const expandedConfigured = explicitConfigured
      ? expandHomePath(configured, environment)
      : configured;
    const candidates = yield* commonPiBinaryCandidates("pi-acp", environment);
    const detected =
      (yield* firstExistingPath(candidates)) ??
      (yield* detectPiFromLoginShell("pi-acp", environment));

    if (!explicitConfigured && configured === "pi-acp" && detected) {
      return { binaryPath: detected, suggestedBinaryPath: detected };
    }

    return {
      binaryPath: expandedConfigured,
      suggestedBinaryPath: detected && detected !== expandedConfigured ? detected : null,
    };
  });
}

export function resolvePiCliBinary(
  piSettings: Pick<PiSettings, "piBinaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  PiBinaryResolution,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const configured = piSettings.piBinaryPath.trim() || "pi";
    const explicitConfigured = isExplicitBinaryPath(configured);
    const expandedConfigured = explicitConfigured
      ? expandHomePath(configured, environment)
      : configured;
    const candidates = yield* commonPiBinaryCandidates("pi", environment);
    const detected =
      (yield* firstExistingPath(candidates)) ?? (yield* detectPiFromLoginShell("pi", environment));

    if (!explicitConfigured && configured === "pi" && detected) {
      return { binaryPath: detected, suggestedBinaryPath: detected };
    }

    return {
      binaryPath: expandedConfigured,
      suggestedBinaryPath: detected && detected !== expandedConfigured ? detected : null,
    };
  });
}

function getPiModels(
  piSettings: Pick<PiSettings, "customModels">,
  defaults: PiConfigModelDefaults,
): ReadonlyArray<ServerProviderModel> {
  const baseModels =
    defaults.defaultProvider === "openai-codex"
      ? PI_OPENAI_CODEX_MODELS
      : [modelFromPiDefault(defaults.defaultModel)];
  return providerModelsFromSettings(
    baseModels,
    PROVIDER,
    piSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export function getPiFallbackModels(
  piSettings: Pick<PiSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    PI_DEFAULT_MODELS,
    PROVIDER,
    piSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getPiFallbackModels(piSettings);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi Agent availability...",
      },
    });
  });
}

interface PiAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

function extractVersion(raw: string): string | null {
  const plain = stripAnsi(raw);
  const aboutMatch = /^CLI Version\s{2,}(.+)$/im.exec(plain);
  if (aboutMatch?.[1]) return aboutMatch[1].trim();
  const versionMatch = /\b(?:pi(?:-agent)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(plain);
  return versionMatch?.[1]?.trim() ?? null;
}

function parsePiAboutOutput(result: CommandResult): PiAboutResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lower = combined.toLowerCase();
  const version = extractVersion(combined);
  const detail = stripAnsi(combined).trim();

  if (lower.includes("not logged in") || lower.includes("authentication required")) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message:
        "Pi Agent is not authenticated. Run `pi` in a terminal and configure a model provider.",
    };
  }

  if (result.code === 0) {
    return {
      version,
      status: "ready",
      auth: { status: "unknown" },
    };
  }

  return {
    version,
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Pi Agent CLI health check exited with code ${result.code}: ${detail}`
      : "Pi Agent is installed, but T3 Code could not verify its auth status.",
  };
}

const runRawCommand = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(binaryPath, [...args], {
      env: environment,
      shell: process.platform === "win32",
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runPiCommand = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) => runRawCommand(binaryPath, args, environment);

const runPiAboutCommand = (binaryPath: string, environment: NodeJS.ProcessEnv = process.env) =>
  runPiCommand(binaryPath, ["--version"], environment).pipe(
    Effect.catch(() => runPiCommand(binaryPath, ["about"], environment)),
  );

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const configDefaults = yield* readPiConfigModelDefaults(environment);
  const authState = yield* readPiAuthState(environment);
  const models = getPiModels(piSettings, configDefaults);
  const binaryResolution = yield* resolvePiBinary(piSettings, environment);
  const piCliResolution = yield* resolvePiCliBinary(piSettings, environment);
  const withPiHints = (snapshot: ServerProviderDraft): ServerProviderDraft => ({
    ...snapshot,
    ...(binaryResolution.suggestedBinaryPath
      ? { suggestedBinaryPath: binaryResolution.suggestedBinaryPath }
      : {}),
  });

  if (!piSettings.enabled) {
    return withPiHints(
      buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      }),
    );
  }

  const adapterPathIsExplicit = isExplicitBinaryPath(binaryResolution.binaryPath);
  const adapterExists = adapterPathIsExplicit
    ? yield* firstExistingPath([binaryResolution.binaryPath])
    : binaryResolution.suggestedBinaryPath;
  if (!adapterExists) {
    const missingMessage = binaryResolution.suggestedBinaryPath
      ? `Pi ACP adapter was not found at \`${binaryResolution.binaryPath}\`. Detected pi-acp at \`${binaryResolution.suggestedBinaryPath}\`; use the detected path or update ACP adapter path.`
      : adapterPathIsExplicit
        ? `Pi ACP adapter was not found at \`${binaryResolution.binaryPath}\`. Install it with \`npm install -g pi-acp\` or update ACP adapter path.`
        : "Pi ACP adapter (`pi-acp`) is not installed or not on PATH. Install it with `npm install -g pi-acp`.";
    return withPiHints(
      buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missingMessage,
        },
      }),
    );
  }

  const piProbe = yield* runPiAboutCommand(piCliResolution.binaryPath, {
    ...environment,
    PI_ACP_PI_COMMAND: piCliResolution.binaryPath,
  }).pipe(Effect.timeoutOption(ABOUT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(piProbe)) {
    const error =
      piProbe.failure instanceof Error
        ? piProbe.failure
        : new Error(
            typeof piProbe.failure === "string" ? piProbe.failure : String(piProbe.failure),
          );
    const isMissing = isCommandMissingCause(error);
    const missingMessage = piCliResolution.suggestedBinaryPath
      ? `Pi Agent CLI was not found at \`${piCliResolution.binaryPath}\`. Detected Pi at \`${piCliResolution.suggestedBinaryPath}\`; use the detected path or update Pi binary path.`
      : "Pi Agent CLI (`pi`) is not installed or not on PATH. Install it with `npm install -g @earendil-works/pi-coding-agent`.";
    return withPiHints(
      buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: !isMissing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isMissing
            ? missingMessage
            : `Failed to execute Pi Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      }),
    );
  }

  if (Option.isNone(piProbe.success)) {
    return withPiHints(
      buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi Agent CLI is installed but timed out during the health check.",
        },
      }),
    );
  }

  const parsed = parsePiAboutOutput(piProbe.success.value);
  if (authState.status === "expired" || authState.status === "missing") {
    const providerLabel = authState.provider ? ` for ${authState.provider}` : "";
    const expiryLabel = authState.expiresAt ? ` expired on ${authState.expiresAt}` : " is missing";
    const loginHint =
      authState.provider === "openai-codex"
        ? " Run `pi`, use `/login`, and choose ChatGPT Plus/Pro (Codex) to enable GPT-5.5."
        : " Run `pi` in a terminal to refresh the login or configure a provider API key.";
    return withPiHints(
      buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsed.version,
          status: "error",
          auth: { status: "unauthenticated" },
          message: `Pi authentication${providerLabel}${expiryLabel}.${loginHint}`,
        },
      }),
    );
  }

  const configMessage =
    parsed.status === "ready" && configDefaults.malformed
      ? "Pi Agent is ready, but T3 Code could not read a configured default model; add a custom model in Settings if the picker needs a specific model name."
      : (parsed.message ??
        (parsed.status === "ready" && configDefaults.defaultProvider && configDefaults.defaultModel
          ? `Pi Agent is ready. Auth provider: ${configDefaults.defaultProvider}. Default model: ${configDefaults.defaultModel}.`
          : undefined));
  return withPiHints(
    buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsed.version,
        status: parsed.status,
        auth: parsed.auth,
        ...(configMessage ? { message: configMessage } : {}),
      },
    }),
  );
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void, never> => {
  const stampIdentity = input.stampIdentity ?? ((value) => value);
  return enrichProviderSnapshotWithVersionAdvisory(
    input.snapshot,
    input.maintenanceCapabilities,
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((snapshot) => input.publishSnapshot(stampIdentity(snapshot))),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
};
