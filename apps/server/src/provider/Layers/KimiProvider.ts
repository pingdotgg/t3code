import {
  type CustomModelSetting,
  type KimiSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
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
import { resolveKimiCredentialsPath } from "../acp/KimiAcpSupport.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi Code",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Built-in Kimi models. The live `session/new` configOptions remain the
 * source of truth at runtime; this list only seeds the picker when the CLI
 * cannot be probed.
 */
const KIMI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-code/kimi-for-coding",
    name: "Kimi for Coding",
    isDefault: true,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "kimi-code/kimi-for-coding-highspeed",
    name: "Kimi for Coding Highspeed",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  { slug: "kimi-code/k3", name: "K3", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  {
    slug: "kimi-code/k3-256k",
    name: "K3 256K",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/** Creates the settings-derived snapshot used before any Kimi CLI probe runs. */
export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kimiModelsFromSettings(kimiSettings.customModels);

    if (!kimiSettings.enabled) {
      return buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi Code is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi Code CLI availability...",
      },
    });
  });
}

function kimiModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

const runKimiCliCommand = (
  kimiSettings: KimiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kimiSettings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Probes Kimi's version and login-file presence, representing probe failures
 * in the returned provider snapshot without reading the credential file.
 */
export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimiModelsFromSettings(kimiSettings.customModels);

  if (!kimiSettings.enabled) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi Code is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKimiCliCommand(kimiSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kimi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : "Failed to execute Kimi Code CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but timed out while running `kimi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kimi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but failed to run.",
      },
    });
  }

  // `kimi login` writes a token file; its existence is the login signal.
  // The file itself is never read.
  const credentialsPath = resolveKimiCredentialsPath(environment);
  const credentialsExist = yield* fileSystem.exists(credentialsPath).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.map((result) => Option.getOrElse(result, () => false)),
    Effect.orElseSucceed(() => false),
  );

  const auth: ServerProviderAuth = credentialsExist
    ? { status: "authenticated", type: "cached_token", label: "Kimi account" }
    : { status: "unauthenticated" };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Kimi Code CLI is installed but not logged in. Run `kimi login`.",
      },
    });
  }

  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: kimiSettings.enabled,
    checkedAt,
    models: fallbackModels,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

/** Publishes version-advisory metadata, logging and suppressing enrichment failures. */
export const enrichKimiSnapshot = (input: {
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
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

/**
 * Kimi advertises its ACP command list through `available_commands_update`
 * notifications once a session starts, not through `initialize` metadata.
 * The catalog records the latest list per workspace so the provider
 * snapshot can surface it; until a session has run the snapshot falls back
 * to the built-in compact command.
 */
export const makeKimiCommandCatalog = Effect.fn("makeKimiCommandCatalog")(function* (
  provider: ServerProviderShape,
) {
  const workspaces = yield* SubscriptionRef.make<NonNullable<ServerProvider["workspaceSnapshots"]>>(
    [],
  );
  const getSnapshot = Effect.all([provider.getSnapshot, SubscriptionRef.get(workspaces)]).pipe(
    Effect.map(([snapshot, workspaceSnapshots]) =>
      workspaceSnapshots.length > 0 ? { ...snapshot, workspaceSnapshots } : snapshot,
    ),
  );
  const snapshotForCwd = Effect.fn("KimiCommandCatalog.snapshotForCwd")(function* (cwd: string) {
    const machineSnapshot = yield* provider.getSnapshot;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        {
          cwd,
          checkedAt,
          slashCommands:
            entries.find((entry) => entry.cwd === cwd)?.slashCommands ??
            machineSnapshot.slashCommands,
          skills: entries.find((entry) => entry.cwd === cwd)?.skills ?? machineSnapshot.skills,
        },
      ].slice(-16),
    );
    const snapshot = yield* getSnapshot;
    return {
      ...snapshot,
      checkedAt,
      slashCommands:
        snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.slashCommands ??
        snapshot.slashCommands,
    };
  });
  // Kimi's advertised list is passed through verbatim, minus malformed rows.
  // Unknown-to-t3 commands are Kimi's concern: the CLI rejects them itself.
  const onAvailableCommands = Effect.fn("KimiCommandCatalog.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) {
    const seen = new Set<string>();
    const slashCommands = commands.flatMap((command) => {
      const name = command.name.trim();
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const description = command.description.trim();
      const hint = command.input?.hint.trim();
      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(hint ? { input: { hint } } : {}),
        },
      ];
    });
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        {
          cwd,
          checkedAt,
          slashCommands,
          skills: entries.find((entry) => entry.cwd === cwd)?.skills ?? [],
        },
      ].slice(-16),
    );
  });
  return {
    onAvailableCommands,
    snapshotForCwd,
    snapshot: {
      ...provider,
      getSnapshot,
      refresh: provider.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: Stream.merge(
        provider.streamChanges.pipe(Stream.map(() => undefined)),
        SubscriptionRef.changes(workspaces).pipe(Stream.map(() => undefined)),
      ).pipe(Stream.mapEffect(() => getSnapshot)),
    } satisfies ServerProviderShape,
  };
});
