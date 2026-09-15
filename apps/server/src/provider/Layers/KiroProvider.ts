import {
  type CustomModelSetting,
  KIRO_DEFAULT_MODEL,
  type KiroSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

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
import { resolveKiroAcpBaseModelId } from "../acp/KiroAcpSupport.ts";

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIRO_DEFAULT_MODEL,
    name: "Auto",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

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

function kiroModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** First JSON object line on stdout. Kiro prints human-readable trailers after its JSON payload. */
function leadingJsonLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("{"));
}

const KiroWhoamiJson = Schema.Struct({
  accountType: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const decodeKiroWhoamiJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(KiroWhoamiJson));
const decodeKiroWhoami = (output: string) => {
  const line = leadingJsonLine(output);
  if (line === undefined) {
    return undefined;
  }
  const exit = decodeKiroWhoamiJsonExit(line);
  return Exit.isSuccess(exit) ? exit.value : undefined;
};

export interface KiroWhoamiCliOutput {
  /** True or false when the CLI reported a login state, null when the output is unrecognized. */
  readonly authenticated: boolean | null;
  readonly email?: string;
  readonly accountType?: string;
}

/**
 * Parses `kiro-cli whoami --format json`. A signed-in CLI prints one JSON line
 * (`{"accountType":"IamIdentityCenter","email":"...",...}`) followed by a
 * plain-text profile block; a signed-out CLI exits non-zero with a
 * "not logged in" message.
 */
export function parseKiroWhoamiOutput(output: string): KiroWhoamiCliOutput {
  const decoded = decodeKiroWhoami(output);
  if (decoded) {
    const email = decoded.email?.trim();
    const accountType = decoded.accountType?.trim();
    return {
      authenticated: true,
      ...(email ? { email } : {}),
      ...(accountType ? { accountType } : {}),
    };
  }
  return {
    authenticated: /not logged in|not authenticated|please log in/i.test(output) ? false : null,
  };
}

const KiroModelsJson = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      model_id: Schema.String,
      model_name: Schema.optional(Schema.String),
    }),
  ),
  default_model: Schema.optional(Schema.String),
});
const decodeKiroModelsJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(KiroModelsJson));
const decodeKiroModels = (output: string) => {
  const line = leadingJsonLine(output);
  if (line === undefined) {
    return undefined;
  }
  const exit = decodeKiroModelsJsonExit(line);
  return Exit.isSuccess(exit) ? exit.value : undefined;
};

/**
 * Parses `kiro-cli chat --list-models --format json`. The command lists the
 * account's catalog without starting an agent session, so the provider probe
 * can refresh models without booting MCP servers.
 */
export function parseKiroModelsCliOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const decoded = decodeKiroModels(output);
  if (!decoded) {
    return [];
  }
  const defaultModel = decoded.default_model?.trim() || KIRO_DEFAULT_MODEL;
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of decoded.models) {
    const slug = resolveKiroAcpBaseModelId(entry.model_id);
    if (!entry.model_id.trim() || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: displayNameFromKiroModel(entry.model_name?.trim() || slug),
      isCustom: false,
      ...(slug === defaultModel ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

function displayNameFromKiroModel(name: string): string {
  return name === KIRO_DEFAULT_MODEL ? "Auto" : name;
}

const runKiroCliCommand = (
  kiroSettings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kiroSettings.binaryPath || "kiro-cli";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kiroModelsFromSettings(kiroSettings.customModels);

  if (!kiroSettings.enabled) {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kiro is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKiroCliCommand(kiroSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kiro CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
          : "Failed to execute Kiro CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI is installed but timed out while running `kiro-cli --version`.",
      },
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
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI is installed but failed to run.",
      },
    });
  }

  // `whoami` reads the credential store without starting the agent.
  const whoamiResult = yield* runKiroCliCommand(
    kiroSettings,
    ["whoami", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const whoami: KiroWhoamiCliOutput =
    Result.isSuccess(whoamiResult) && Option.isSome(whoamiResult.success)
      ? whoamiResult.success.value.code === 0
        ? parseKiroWhoamiOutput(whoamiResult.success.value.stdout)
        : // A signed-out CLI exits non-zero; only trust that verdict when the text confirms it.
          {
            authenticated:
              parseKiroWhoamiOutput(
                `${whoamiResult.success.value.stdout}\n${whoamiResult.success.value.stderr}`,
              ).authenticated === false
                ? false
                : null,
          }
      : { authenticated: null };
  if (whoami.authenticated === null) {
    yield* Effect.logWarning("Kiro CLI login probe failed, timed out, or was unrecognized.", {
      errorTag: Result.isFailure(whoamiResult)
        ? whoamiResult.failure._tag
        : Option.isNone(whoamiResult.success)
          ? "Timeout"
          : `ExitCode${whoamiResult.success.value.code}`,
    });
  }

  const auth: ServerProviderAuth =
    whoami.authenticated === true
      ? {
          status: "authenticated",
          type: "cached_token",
          label: "Kiro account",
          ...(whoami.email ? { email: whoami.email } : {}),
        }
      : whoami.authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Kiro CLI is installed but not logged in. Run `kiro-cli login`.",
      },
    });
  }

  // The model catalog comes from the account, so it needs a login but no agent session.
  const modelsExit = yield* runKiroCliCommand(
    kiroSettings,
    ["chat", "--list-models", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.exit);
  const modelsOutput =
    Exit.isSuccess(modelsExit) &&
    Option.isSome(modelsExit.value) &&
    modelsExit.value.value.code === 0
      ? modelsExit.value.value
      : undefined;
  const discoveredModels = modelsOutput ? parseKiroModelsCliOutput(modelsOutput.stdout) : [];
  const modelsFailed = discoveredModels.length === 0;
  if (modelsFailed) {
    yield* Effect.logWarning("Kiro CLI model listing failed, timed out, or returned no models.", {
      errorTag: Exit.isFailure(modelsExit)
        ? causeErrorTag(modelsExit.cause)
        : Option.isNone(modelsExit.value)
          ? "Timeout"
          : `ExitCode${modelsExit.value.value.code}`,
    });
  }
  const models = modelsFailed
    ? fallbackModels
    : kiroModelsFromSettings(kiroSettings.customModels, discoveredModels);

  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: kiroSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed catalog probe degrades the model picker, it does not make chats fail.
      status: modelsFailed ? "warning" : "ready",
      auth,
      ...(modelsFailed
        ? {
            message:
              "Kiro CLI is installed but its model list could not be read. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichKiroSnapshot = (input: {
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
      Effect.logWarning("Kiro version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
