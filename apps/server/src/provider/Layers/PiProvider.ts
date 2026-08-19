/**
 * PiProvider — snapshot/probe layer for the Pi coding agent.
 *
 * Health is probed with `pi --version`. Models, the user's default model, and
 * the user's commands (extension slash commands, prompt templates, skills)
 * are discovered through a short-lived ephemeral RPC session
 * (`pi --mode rpc --no-session`), so everything the user configured in
 * `~/.pi/agent` — custom providers, models.json entries, extensions, skills —
 * shows up in T3 without any hardcoded catalog.
 */
import { type PiSettings, type ServerProvider, type ServerProviderModel } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  makePiRpcConnection,
  piRecordField as recordField,
  piRecordString as recordString,
} from "../../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";
import { parsePiDiscoveredCommands, type PiDiscoveredCommands } from "../PiCommands.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_RPC_DISCOVERY_TIMEOUT_MS = 15_000;

/** Deferring to the user's own settings.json default model. */
const PI_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Pi default",
  isCustom: false,
  capabilities: EMPTY_PI_MODEL_CAPABILITIES,
};

interface PiDiscovery extends PiDiscoveredCommands {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authenticated: boolean;
}

function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [PI_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

function parseDiscoveredModels(
  data: unknown,
  defaultThinkingLevel: unknown,
): ReadonlyArray<ServerProviderModel> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      isCustom: false,
      capabilities: thinkingCapabilitiesForPiModel(model, defaultThinkingLevel),
    });
  }
  return parsed;
}

const discoverPiViaRpc = (piSettings: PiSettings, environment: NodeJS.ProcessEnv, cwd?: string) =>
  Effect.gen(function* () {
    const connection = yield* makePiRpcConnection({
      command: piSettings.binaryPath || "pi",
      args: ["--mode", "rpc", "--no-session", ...tokenizeCliArgs(piSettings.launchArgs)],
      cwd,
      env: environment,
    });
    const stateData = yield* connection.request({ type: "get_state" });
    const modelsData = yield* connection.request({ type: "get_available_models" });
    const commandsData = yield* connection
      .request({ type: "get_commands" })
      .pipe(Effect.orElseSucceed(() => undefined));
    const discoveredModels = parseDiscoveredModels(
      modelsData,
      recordString(stateData, "thinkingLevel"),
    );
    const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
    return {
      models: discoveredModels,
      slashCommands,
      skills,
      authenticated: discoveredModels.length > 0,
    } satisfies PiDiscovery;
  }).pipe(Effect.scoped);

const runPiVersionCommand = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);
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
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH. Install with `npm install -g @earendil-works/pi-coding-agent`."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverPiViaRpc(piSettings, environment, cwd).pipe(
    Effect.timeoutOption(PI_RPC_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Pi RPC discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but RPC startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi CLI is installed but RPC startup timed out after ${PI_RPC_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = piModelsFromSettings(piSettings.customModels, discovery.models);
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "pi" },
      ...(discovery.authenticated
        ? {}
        : {
            message:
              "Pi has no usable models. Run `pi` in a terminal and use /login, or configure an API key in ~/.pi/agent.",
          }),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
