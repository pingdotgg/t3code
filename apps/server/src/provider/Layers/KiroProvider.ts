import {
  type CustomModelSetting,
  type KiroSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { KIRO_DEFAULT_MODEL_ID, kiroCliFailure } from "../acp/KiroAcpSupport.ts";

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  supportsConversationRollback: false,
  // T3's Plan mode is not wired to Kiro's planning agent yet.
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIRO_DEFAULT_MODEL_ID,
    name: "Auto",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function kiroModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function disabledKiroSnapshot(checkedAt: string, kiroSettings: KiroSettings): ServerProviderDraft {
  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: false,
    checkedAt,
    models: kiroModelsFromSettings(kiroSettings.customModels),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Kiro is disabled in T3 Code settings.",
    },
  });
}

export function buildInitialKiroProviderSnapshot(
  kiroSettings: KiroSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (!kiroSettings.enabled) return disabledKiroSnapshot(checkedAt, kiroSettings);
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models: kiroModelsFromSettings(kiroSettings.customModels),
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

const KiroWhoami = Schema.Struct({
  accountType: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeKiroWhoami = Schema.decodeUnknownOption(Schema.fromJsonString(KiroWhoami));

/**
 * Parses `kiro-cli whoami --format json`. Logged in, the CLI prints
 * `{"accountType":"SocialGoogle","email":"…"}`; logged out it prints the text
 * `Not logged in`.
 */
export function parseKiroWhoamiOutput(output: string): ServerProviderAuth {
  const trimmed = output.trim();
  const decoded = decodeKiroWhoami(trimmed);
  if (Option.isSome(decoded)) {
    const email = decoded.value.email?.trim();
    return {
      status: "authenticated",
      type: "cached_token",
      label: "Kiro account",
      ...(email ? { email } : {}),
    };
  }
  return /not logged in/i.test(trimmed) ? { status: "unauthenticated" } : { status: "unknown" };
}

const KiroModelsCliOutput = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      model_id: Schema.String,
      model_name: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeKiroModelsCliOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(KiroModelsCliOutput),
);

/** Parses `kiro-cli chat --list-models --format json`; `auto` stays the default. */
export function parseKiroModelsCliOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const decoded = decodeKiroModelsCliOutput(output.trim());
  if (Option.isNone(decoded)) return [];
  const seen = new Set<string>();
  return decoded.value.models.flatMap((model): ServerProviderModel[] => {
    const slug = model.model_id.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: slug === KIRO_DEFAULT_MODEL_ID ? "Auto" : model.model_name?.trim() || slug,
        isCustom: false,
        ...(slug === KIRO_DEFAULT_MODEL_ID ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
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

/**
 * Health check from three CLI commands that never open a chat session:
 * `--version`, `whoami`, and `chat --list-models`. Opening a session would
 * record it under `~/.kiro/sessions` and start the agent's MCP servers.
 */
export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kiroModelsFromSettings(kiroSettings.customModels);

  if (!kiroSettings.enabled) return disabledKiroSnapshot(checkedAt, kiroSettings);

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

  const whoamiResult = yield* runKiroCliCommand(
    kiroSettings,
    ["whoami", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const whoamiOutput =
    Result.isSuccess(whoamiResult) && Option.isSome(whoamiResult.success)
      ? whoamiResult.success.value
      : undefined;
  // Logged-out installs exit non-zero, so the text is read whatever the code.
  const auth: ServerProviderAuth = whoamiOutput
    ? parseKiroWhoamiOutput(`${whoamiOutput.stdout}\n${whoamiOutput.stderr}`)
    : { status: "unknown" };
  const setupFailure = whoamiOutput ? kiroCliFailure(whoamiOutput.stderr) : undefined;
  if (!whoamiOutput) {
    yield* Effect.logWarning("Kiro CLI whoami probe failed or timed out.", {
      errorTag: Result.isFailure(whoamiResult) ? whoamiResult.failure._tag : "Timeout",
    });
  }

  if (auth.status === "unauthenticated" || setupFailure !== undefined) {
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
        message:
          setupFailure?.message ?? "Kiro CLI is installed but not logged in. Run `kiro-cli login`.",
      },
    });
  }

  const modelsResult = yield* runKiroCliCommand(
    kiroSettings,
    ["chat", "--list-models", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value
      : undefined;
  const cliModels = modelsOutput ? parseKiroModelsCliOutput(modelsOutput.stdout) : [];
  const modelsFailed = cliModels.length === 0;
  if (modelsFailed) {
    yield* Effect.logWarning("Kiro CLI model listing failed or timed out.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }
  const modelsSetupFailure =
    Result.isSuccess(modelsResult) && Option.isSome(modelsResult.success)
      ? kiroCliFailure(modelsResult.success.value.stderr)
      : undefined;
  if (modelsSetupFailure !== undefined) {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: modelsSetupFailure.kind === "not-logged-in" ? { status: "unauthenticated" } : auth,
        message: modelsSetupFailure.message,
      },
    });
  }

  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: kiroSettings.enabled,
    checkedAt,
    models: modelsFailed
      ? fallbackModels
      : kiroModelsFromSettings(kiroSettings.customModels, cliModels),
    probe: {
      installed: true,
      version,
      // A failed model listing degrades the model picker, it does not make chats fail.
      status: modelsFailed ? "warning" : "ready",
      auth,
      ...(modelsFailed
        ? {
            message:
              "Kiro CLI is installed but listing models failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});
