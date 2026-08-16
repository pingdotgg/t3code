/**
 * KiroProvider — snapshot and health probe for the Kiro CLI.
 *
 * Unlike the other ACP drivers, Kiro answers all three questions the provider
 * card asks without booting an ACP session:
 *
 *   - `kiro-cli --version` for installed/version,
 *   - `kiro-cli whoami --format json` for a real auth status, and
 *   - `kiro-cli chat --list-models --format json` for the live model catalog.
 *
 * That keeps refreshes cheap and means a logged-out user gets an actionable
 * message instead of an opaque startup failure.
 *
 * @module provider/Layers/KiroProvider
 */
import {
  type KiroSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildKiroProcessEnvironment } from "../acp/KiroAcpSupport.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  badgeLabel: "Early Access",
  // Kiro's ACP "modes" are agent configurations rather than interaction modes,
  // so there is nothing for the approval/full-access toggle to switch.
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;

const NOT_INSTALLED_MESSAGE = "Kiro CLI (`kiro-cli`) is not installed or not on PATH.";
const UNAUTHENTICATED_MESSAGE =
  "Kiro CLI is not authenticated. Run `kiro-cli login` and try again.";

/**
 * Kiro resolves `auto` itself, so it is the one slug that is always valid —
 * including before a model catalog has been fetched.
 */
const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * `kiro-cli chat --list-models --format json`. Only `model_id` matters; every
 * other field is decoration Kiro may reshape between releases.
 */
const KiroModelListPayload = Schema.Struct({
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        model_id: Schema.String,
        model_name: Schema.optional(Schema.String),
      }),
    ),
  ),
  default_model: Schema.optional(Schema.String),
});

/**
 * `kiro-cli whoami --format json`. The command prints this object and then a
 * human-readable "Profile:" block, so the payload is extracted before decoding.
 */
const KiroWhoamiPayload = Schema.Struct({
  accountType: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

const decodeModelListPayload = Schema.decodeEffect(Schema.fromJsonString(KiroModelListPayload));
const decodeWhoamiPayload = Schema.decodeEffect(Schema.fromJsonString(KiroWhoamiPayload));

const runKiroCommand = (
  kiroSettings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kiroSettings.binaryPath || "kiro-cli";
    const processEnv = buildKiroProcessEnvironment(kiroSettings, environment);
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: processEnv });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: processEnv,
        shell: spawnCommand.shell,
      }),
    );
  });

function kiroModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Auth status from `whoami`. A non-zero exit or unreadable payload is read as
 * "not logged in", which is what it means in practice — Kiro exits non-zero
 * with a login hint when no credentials are present.
 */
export const probeKiroAuth = Effect.fn("probeKiroAuth")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  { readonly auth: ServerProviderAuth; readonly message?: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const whoamiResult = yield* runKiroCommand(
    kiroSettings,
    ["whoami", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(whoamiResult) || Option.isNone(whoamiResult.success)) {
    yield* Effect.logWarning("Kiro CLI auth probe did not complete.", {
      timedOut: Result.isSuccess(whoamiResult),
    });
    return { auth: { status: "unknown" } };
  }

  const output = whoamiResult.success.value;
  if (output.code !== 0) {
    return {
      auth: { status: "unauthenticated" },
      message: UNAUTHENTICATED_MESSAGE,
    };
  }

  const decoded = yield* decodeWhoamiPayload(extractJsonObject(output.stdout)).pipe(Effect.option);
  if (Option.isNone(decoded)) {
    // Exited cleanly but the payload changed shape: report authenticated
    // without embellishment rather than inventing a failure.
    return { auth: { status: "authenticated" } };
  }

  const email = decoded.value.email?.trim();
  const accountType = decoded.value.accountType?.trim();
  return {
    auth: {
      status: "authenticated",
      ...(accountType ? { type: accountType } : {}),
      ...(email ? { email } : {}),
    },
  };
});

/**
 * Live model catalog. Returns an empty array when the command fails so the
 * caller can fall back to the built-in list instead of showing no models.
 */
export const discoverKiroModels = Effect.fn("discoverKiroModels")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const listResult = yield* runKiroCommand(
    kiroSettings,
    ["chat", "--list-models", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(MODEL_LIST_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(listResult) || Option.isNone(listResult.success)) {
    yield* Effect.logWarning("Kiro CLI model discovery did not complete.", {
      timedOut: Result.isSuccess(listResult),
    });
    return [];
  }

  const output = listResult.success.value;
  if (output.code !== 0) {
    yield* Effect.logWarning("Kiro CLI model discovery exited with a non-zero status.", {
      exitCode: output.code,
    });
    return [];
  }

  const decoded = yield* decodeModelListPayload(extractJsonObject(output.stdout)).pipe(
    Effect.option,
  );
  if (Option.isNone(decoded)) {
    yield* Effect.logWarning("Kiro CLI model list could not be decoded.");
    return [];
  }

  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const entry of decoded.value.models ?? []) {
    const slug = entry.model_id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: entry.model_name?.trim() || slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
});

export function buildInitialKiroProviderSnapshot(
  kiroSettings: KiroSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kiroModelsFromSettings(kiroSettings.customModels);

    if (!kiroSettings.enabled) {
      return buildServerProvider({
        presentation: KIRO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kiro is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kiro CLI availability...",
      },
    });
  });
}

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kiroModelsFromSettings(kiroSettings.customModels);
  const snapshot = (probe: ProviderProbeResult, models = fallbackModels) =>
    buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!kiroSettings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Kiro is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runKiroCommand(kiroSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kiro CLI health check failed.", { errorTag: error._tag });
    return snapshot({
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? NOT_INSTALLED_MESSAGE
        : "Failed to execute Kiro CLI health check.",
    });
  }

  if (Option.isNone(versionResult.success)) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Kiro CLI is installed but timed out while running `kiro-cli --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kiro CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Kiro CLI is installed but failed to run.",
    });
  }

  const { auth, message: authMessage } = yield* probeKiroAuth(kiroSettings, environment);
  if (auth.status === "unauthenticated") {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth,
      ...(authMessage ? { message: authMessage } : {}),
    });
  }

  const discoveredModels = yield* discoverKiroModels(kiroSettings, environment);
  const models =
    discoveredModels.length > 0
      ? kiroModelsFromSettings(kiroSettings.customModels, discoveredModels)
      : fallbackModels;

  return snapshot(
    {
      installed: true,
      version,
      status: "ready",
      auth,
      ...(discoveredModels.length === 0
        ? { message: "Kiro CLI is ready, but its model list could not be read." }
        : {}),
    },
    models,
  );
});

export const enrichKiroSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kiro version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
