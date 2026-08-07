import { type OpenClawSettings, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

/**
 * OpenClaw exposes a per-session "thinking level" that the adapter forwards
 * to the gateway (`sessions.create { thinkingLevel }`, `agent { thinking }`).
 * The adapter already reads a `reasoningEffort` selection, so advertising the
 * descriptor here makes the composer surface the toggle. The vocabulary mirrors
 * PiAgent (the only other runtime with a `thinkingLevel`/`setThinkingLevel`
 * wire shape); values are forwarded verbatim, so levels the gateway rejects
 * surface as gateway errors rather than silent no-ops.
 */
const OPENCLAW_REASONING_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

function openClawModelCapabilities() {
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: OPENCLAW_REASONING_OPTIONS,
      }),
    ],
  });
}
import {
  OpenClawRuntime,
  openClawRuntimeErrorDetail,
  type OpenClawGatewayConnection,
  type OpenClawRuntimeShape,
} from "../openclawRuntime.ts";

const OPENCLAW_PRESENTATION = {
  displayName: "OpenClaw",
  showInteractionModeToggle: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Static catalog used when the gateway/CLI model catalog cannot be probed.
 * The default session model and default textgen model come from the shared
 * contracts; custom models from settings are always appended on top.
 */
const OPENCLAW_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: openClawModelCapabilities(),
  },
  {
    slug: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: openClawModelCapabilities(),
  },
];

function openClawModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = OPENCLAW_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], openClawModelCapabilities());
}

export function makePendingOpenClawProvider(
  openClawSettings: OpenClawSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = openClawModelsFromSettings(openClawSettings.customModels);

    if (!openClawSettings.enabled) {
      return buildServerProvider({
        presentation: OPENCLAW_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenClaw is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking OpenClaw gateway availability...",
      },
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the gateway `models.list` payload defensively. The CLI envelope is
 * verified against `openclaw models list --json` (2026.7.1): entries carry
 * `key` (not `id`) plus `available`/`missing` flags, e.g.
 * `{count, models: [{key, name, available, missing, tags}]}`. The gateway
 * envelope is not pinned by the public docs, so we still accept several
 * plausible shapes (`models`, `catalog`, `default.models`, `id` or `key`)
 * and return `undefined` when nothing parses (the caller falls back to the
 * static catalog). Entries explicitly flagged unavailable or missing are
 * dropped: the gateway refuses them at session time.
 */
export function parseOpenClawModelsList(
  payload: unknown,
): ReadonlyArray<{ readonly id: string; readonly name?: string }> | undefined {
  const collect = (value: unknown): ReadonlyArray<{ id: string; name?: string }> => {
    if (!Array.isArray(value)) {
      return [];
    }
    const entries: Array<{ id: string; name?: string }> = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        const id = entry.trim();
        if (id) {
          entries.push({ id });
        }
        continue;
      }
      if (isRecord(entry)) {
        if (entry.available === false || entry.missing === true) {
          continue;
        }
        const rawId = typeof entry.id === "string" ? entry.id : entry.key;
        const id = typeof rawId === "string" ? rawId.trim() : undefined;
        if (id) {
          entries.push({
            id,
            ...(typeof entry.name === "string" && entry.name.trim()
              ? { name: entry.name.trim() }
              : {}),
          });
        }
      }
    }
    return entries;
  };

  if (!isRecord(payload)) {
    return undefined;
  }
  for (const key of ["models", "catalog"] as const) {
    const entries = collect(payload[key]);
    if (entries.length > 0) {
      return entries;
    }
  }
  const def = payload.default;
  if (isRecord(def)) {
    const entries = collect(def.models);
    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

export function openClawDiscoveredModelsFromCatalog(
  entries: ReadonlyArray<{ readonly id: string; readonly name?: string }>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return entries
    .map((entry): ServerProviderModel | undefined => {
      const slug = entry.id.trim();
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: entry.name?.trim() || slug,
        isCustom: false,
        capabilities: openClawModelCapabilities(),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

/**
 * Probe the configured external gateway over the WebSocket control plane:
 * handshake (version) + `models.list`. The connection is scoped to the probe.
 */
const probeExternalGateway = (
  openClawRuntime: OpenClawRuntimeShape,
  openClawSettings: OpenClawSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  { readonly version: string; readonly models: ReadonlyArray<ServerProviderModel> },
  unknown
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* openClawRuntime.connectToOpenClawGateway({
        binaryPath: openClawSettings.binaryPath,
        gatewayUrl: openClawSettings.gatewayUrl,
        ...(openClawSettings.gatewayToken?.trim()
          ? { gatewayToken: openClawSettings.gatewayToken }
          : {}),
        environment,
      });
      const catalogResult = yield* loadGatewayModels(connection).pipe(Effect.result);
      const discovered = Result.isSuccess(catalogResult)
        ? openClawDiscoveredModelsFromCatalog(catalogResult.success)
        : [];
      return {
        version: connection.hello.serverVersion,
        models:
          discovered.length > 0
            ? openClawModelsFromSettings(openClawSettings.customModels, discovered)
            : openClawModelsFromSettings(openClawSettings.customModels),
      };
    }),
  );

const loadGatewayModels = (
  connection: OpenClawGatewayConnection,
): Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name?: string }>, unknown> =>
  connection
    .request("models.list", {})
    .pipe(Effect.map((payload) => parseOpenClawModelsList(payload) ?? []));

/**
 * Parse a `--json` CLI payload defensively: try the stdout as JSON, then as a
 * JSON object embedded after the first `{`/`[`. Returns `undefined` when
 * nothing parses.
 */
function parseCliJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Fall through to the substring probe.
  }
  const start = trimmed.search(/[[{]/);
  if (start < 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(start)) as unknown;
  } catch {
    return undefined;
  }
}

const runOpenClawModelsCli = (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  { readonly code: number; readonly payload: unknown },
  unknown,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["models", "list", "--json"], {
      env: environment,
    });
    const result = yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    return { code: result.code, payload: parseCliJsonPayload(result.stdout) };
  });

export const checkOpenClawProviderStatus = Effect.fn("checkOpenClawProviderStatus")(function* (
  openClawSettings: OpenClawSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  OpenClawRuntime | ChildProcessSpawner.ChildProcessSpawner
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = openClawModelsFromSettings(openClawSettings.customModels);
  const isExternalGateway = openClawSettings.gatewayUrl.trim().length > 0;

  const fallback = (cause: unknown, version: string | null = null) => {
    const lower = openClawRuntimeErrorDetail(cause).toLowerCase();
    const missingCommand =
      isCommandMissingCause(cause) || lower.includes("enoent") || lower.includes("notfound");
    const message = missingCommand
      ? "OpenClaw CLI (`openclaw`) is not installed or not on PATH."
      : isExternalGateway
        ? "Couldn't reach the configured OpenClaw gateway. Check the Gateway URL and token."
        : "Failed to execute the OpenClaw CLI health check.";
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openClawSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missingCommand,
        version,
        status: "error",
        auth: { status: "unknown" },
        message,
      },
    });
  };

  if (!openClawSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenClaw is disabled in T3 Code settings.",
      },
    });
  }

  const openClawRuntime = yield* OpenClawRuntime;

  if (isExternalGateway) {
    const probeExit = yield* Effect.exit(
      probeExternalGateway(openClawRuntime, openClawSettings, environment),
    );
    if (Exit.isFailure(probeExit)) {
      return fallback(Cause.squash(probeExit.cause));
    }
    const { version, models } = probeExit.value;
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated", type: "openclaw-gateway" },
        message: `Connected to the OpenClaw gateway (v${version}).`,
      },
    });
  }

  // Spawned-gateway path: probe the CLI instead of starting a full gateway.
  const versionResult = yield* openClawRuntime
    .runOpenClawCommand({
      binaryPath: openClawSettings.binaryPath,
      args: ["--version"],
      environment,
    })
    .pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    return fallback(versionResult.failure);
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: openClawSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenClaw CLI is installed but timed out while running `openclaw --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return fallback(
      new Error(`openclaw --version exited with code ${versionOutput.code}.`),
      version,
    );
  }

  // Model discovery via the CLI is best-effort; an unparseable `models list`
  // falls back to the static catalog.
  const modelsExit = yield* Effect.exit(
    runOpenClawModelsCli(openClawSettings.binaryPath, environment).pipe(
      Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
    ),
  );
  let discovered: ReadonlyArray<{ readonly id: string; readonly name?: string }> | undefined;
  if (Exit.isSuccess(modelsExit)) {
    if (Option.isSome(modelsExit.value)) {
      const result = modelsExit.value.value;
      if (result.code === 0) {
        discovered = parseOpenClawModelsList(result.payload);
      }
    }
  }
  const discoveredModels = discovered ? openClawDiscoveredModelsFromCatalog(discovered) : [];
  const models =
    discoveredModels.length > 0
      ? openClawModelsFromSettings(openClawSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: OPENCLAW_PRESENTATION,
    enabled: openClawSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message: `OpenClaw v${version ?? "?"} is available.`,
    },
  });
});
