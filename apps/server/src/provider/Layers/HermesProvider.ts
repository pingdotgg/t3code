import type {
  HermesSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
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

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const HERMES_FALLBACK_MODEL: ServerProviderModel = {
  slug: "hermes-default",
  name: "Hermes Default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};
const HERMES_DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [HERMES_FALLBACK_MODEL];
const ABOUT_TIMEOUT_MS = 4_000;
const LOGIN_SHELL_TIMEOUT_MS = 2_000;

export interface HermesConfigModelDefaults {
  readonly defaultModel: string | null;
  readonly malformed: boolean;
}

export interface HermesBinaryResolution {
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

export function parseHermesConfigModelDefaults(raw: string): HermesConfigModelDefaults {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let inModelBlock = false;
  let modelIndent = 0;
  let sawModelBlock = false;

  for (const line of lines) {
    const withoutComment = line.replace(/\s*#.*$/, "");
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
    return { defaultModel: value.length > 0 ? value : null, malformed: false };
  }

  return { defaultModel: null, malformed: sawModelBlock };
}

function formatHermesModelName(slug: string): string {
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

function modelFromHermesDefault(defaultModel: string | null): ServerProviderModel {
  const slug = defaultModel?.trim();
  if (!slug) return HERMES_FALLBACK_MODEL;
  return {
    slug,
    name: formatHermesModelName(slug),
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  };
}

function readHermesConfigModelDefaults(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<HermesConfigModelDefaults, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home =
      environment.HERMES_HOME?.trim() || path.join(environment.HOME || NodeOS.homedir(), ".hermes");
    const raw = yield* fs
      .readFileString(path.join(home, "config.yaml"))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return raw ? parseHermesConfigModelDefaults(raw) : { defaultModel: null, malformed: false };
  });
}

function isExplicitBinaryPath(binaryPath: string): boolean {
  return binaryPath.includes("/") || binaryPath.includes("\\") || binaryPath.startsWith("~");
}

function commonHermesBinaryCandidates(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ReadonlyArray<string>, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
    if (process.platform === "win32") {
      const appData = environment.APPDATA;
      const localAppData = environment.LOCALAPPDATA;
      return [
        path.join(home, ".local", "bin", "hermes.exe"),
        path.join(home, ".local", "bin", "hermes.cmd"),
        path.join(home, "Projects", "hermes-agent", "venv", "Scripts", "hermes.exe"),
        path.join(home, "Projects", "hermes-agent", "venv", "Scripts", "hermes.cmd"),
        ...(appData ? [path.join(appData, "Python", "Scripts", "hermes.exe")] : []),
        ...(localAppData
          ? [path.join(localAppData, "Programs", "Python", "Python312", "Scripts", "hermes.exe")]
          : []),
      ];
    }
    return [
      path.join(home, ".local/bin/hermes"),
      path.join(home, "Projects/hermes-agent/venv/bin/hermes"),
      "/opt/homebrew/bin/hermes",
      "/usr/local/bin/hermes",
    ];
  });
}

function expandHomePath(input: string, environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
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

function detectHermesFromLoginShell(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (process.platform === "win32") {
    return runRawCommand("where", ["hermes"], environment).pipe(
      Effect.timeoutOption(LOGIN_SHELL_TIMEOUT_MS),
      Effect.map((result) => {
        if (Option.isNone(result) || result.value.code !== 0) return null;
        const candidate = result.value.stdout.trim().split(/\r?\n/u)[0]?.trim();
        return candidate && candidate.length > 0 ? candidate : null;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );
  }

  const shell = environment.SHELL?.trim() || "/bin/zsh";
  return runRawCommand(shell, ["-lc", "command -v hermes"], environment).pipe(
    Effect.timeoutOption(LOGIN_SHELL_TIMEOUT_MS),
    Effect.map((result) => {
      if (Option.isNone(result) || result.value.code !== 0) return null;
      const candidate = result.value.stdout.trim().split(/\r?\n/u)[0]?.trim();
      return candidate && candidate.length > 0 ? candidate : null;
    }),
    Effect.catch(() => Effect.succeed(null)),
  );
}

export function resolveHermesBinary(
  hermesSettings: Pick<HermesSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  HermesBinaryResolution,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const configured = hermesSettings.binaryPath.trim() || "hermes";
    const explicitConfigured = isExplicitBinaryPath(configured);
    const expandedConfigured = explicitConfigured
      ? expandHomePath(configured, environment)
      : configured;
    const candidates = yield* commonHermesBinaryCandidates(environment);
    const detected =
      (yield* firstExistingPath(candidates)) ?? (yield* detectHermesFromLoginShell(environment));

    if (!explicitConfigured && configured === "hermes" && detected) {
      return { binaryPath: detected, suggestedBinaryPath: detected };
    }

    return {
      binaryPath: expandedConfigured,
      suggestedBinaryPath: detected && detected !== expandedConfigured ? detected : null,
    };
  });
}

function getHermesModels(
  hermesSettings: Pick<HermesSettings, "customModels">,
  defaults: HermesConfigModelDefaults,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [modelFromHermesDefault(defaults.defaultModel)],
    PROVIDER,
    hermesSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export function getHermesFallbackModels(
  hermesSettings: Pick<HermesSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    HERMES_DEFAULT_MODELS,
    PROVIDER,
    hermesSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getHermesFallbackModels(hermesSettings);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes Agent availability...",
      },
    });
  });
}

interface HermesAboutResult {
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
  const versionMatch = /\b(?:hermes(?:-agent)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(plain);
  return versionMatch?.[1]?.trim() ?? null;
}

function parseHermesAboutOutput(result: CommandResult): HermesAboutResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lower = combined.toLowerCase();
  const version = extractVersion(combined);
  const detail = stripAnsi(combined).trim();

  if (lower.includes("not logged in") || lower.includes("authentication required")) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Hermes Agent is not authenticated. Run `hermes setup` or `hermes model`.",
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
      ? `Hermes Agent CLI health check exited with code ${result.code}: ${detail}`
      : "Hermes Agent is installed, but T3 Code could not verify its auth status.",
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

const runHermesCommand = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) => runRawCommand(binaryPath, args, environment);

const runHermesAboutCommand = (binaryPath: string, environment: NodeJS.ProcessEnv = process.env) =>
  runHermesCommand(binaryPath, ["--version"], environment).pipe(
    Effect.catch(() => runHermesCommand(binaryPath, ["about"], environment)),
  );

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const configDefaults = yield* readHermesConfigModelDefaults(environment);
  const models = getHermesModels(hermesSettings, configDefaults);
  const binaryResolution = yield* resolveHermesBinary(hermesSettings, environment);
  const withHermesHints = (snapshot: ServerProviderDraft): ServerProviderDraft => ({
    ...snapshot,
    ...(binaryResolution.suggestedBinaryPath
      ? { suggestedBinaryPath: binaryResolution.suggestedBinaryPath }
      : {}),
  });

  if (!hermesSettings.enabled) {
    return withHermesHints(
      buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      }),
    );
  }

  const probe = yield* runHermesAboutCommand(binaryResolution.binaryPath, environment).pipe(
    Effect.timeoutOption(ABOUT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(probe)) {
    const error =
      probe.failure instanceof Error
        ? probe.failure
        : new Error(typeof probe.failure === "string" ? probe.failure : String(probe.failure));
    const isMissing = isCommandMissingCause(error);
    const missingMessage = binaryResolution.suggestedBinaryPath
      ? `Hermes Agent CLI was not found at \`${binaryResolution.binaryPath}\`. Detected Hermes at \`${binaryResolution.suggestedBinaryPath}\`; use the detected path or update Binary path.`
      : "Hermes Agent CLI (`hermes`) is not installed or not on PATH.";
    return withHermesHints(
      buildServerProvider({
        presentation: HERMES_PRESENTATION,
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
            : `Failed to execute Hermes Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      }),
    );
  }

  if (Option.isNone(probe.success)) {
    return withHermesHints(
      buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes Agent CLI is installed but timed out during the health check.",
        },
      }),
    );
  }

  const parsed = parseHermesAboutOutput(probe.success.value);
  const configMessage =
    parsed.status === "ready" && configDefaults.malformed
      ? "Hermes Agent is ready, but `~/.hermes/config.yaml` has no `model.default`; run `hermes model` to choose the model T3 Code should display."
      : parsed.message;
  return withHermesHints(
    buildServerProvider({
      presentation: HERMES_PRESENTATION,
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

export const enrichHermesSnapshot = (input: {
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
      Effect.logWarning("Hermes version advisory enrichment failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
};
