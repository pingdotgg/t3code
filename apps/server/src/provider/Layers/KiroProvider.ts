import {
  type KiroSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { KIRO_SUPPORTED_RUNTIME_MODES } from "../acp/KiroAcpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "../providerSnapshot.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");
const KIRO_PRESENTATION = {
  displayName: "Kiro",
  showInteractionModeToggle: false,
  supportedRuntimeModes: KIRO_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "default", name: "Kiro default", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];
const KIRO_API_KEY_ENV = "KIRO_API_KEY";

const kiroModels = (
  settings: KiroSettings,
  listed: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
) => providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES);

const snapshot = (
  settings: KiroSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed?: ReadonlyArray<ServerProviderModel>,
) =>
  buildServerProvider({
    // Gives the snapshot its version advisory; Kiro runs no enrichment pass.
    driver: KIRO_DRIVER_KIND,
    presentation: KIRO_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: kiroModels(settings, listed),
    probe,
  });

export const buildInitialKiroProviderSnapshot = (
  settings: KiroSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Kiro CLI availability..."
        : "Kiro is disabled in T3 Code settings.",
    }),
  );

const runKiroCli = (
  settings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "kiro-cli";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const KiroWhoami = Schema.fromJsonString(
  Schema.Struct({
    accountType: Schema.optional(Schema.NullOr(Schema.String)),
    email: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeKiroWhoami = Schema.decodeUnknownOption(KiroWhoami);

/**
 * Reads `kiro-cli whoami --format json`. Kiro 2.27 prints
 * `{"accountType":"ApiKey","email":null}` and exits 0 when signed in (or when
 * `KIRO_API_KEY` is set), and `{"account":null}` with exit 1 when not.
 */
export function kiroAuthFromWhoami(
  output: { readonly code: number; readonly stdout: string } | undefined,
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  if (output === undefined) return { status: "unknown" };
  if (output.code !== 0) {
    return output.stdout.includes('"account":null')
      ? { status: "unauthenticated" }
      : { status: "unknown" };
  }
  const account = Option.getOrUndefined(decodeKiroWhoami(output.stdout.trim()));
  if (account?.accountType === "ApiKey" || environment[KIRO_API_KEY_ENV]?.trim()) {
    return { status: "authenticated", type: "api_key", label: "Kiro API key" };
  }
  return {
    status: "authenticated",
    label: "Kiro account",
    ...(account?.email ? { email: account.email } : {}),
  };
}

const KiroModelList = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        model_id: Schema.String,
        model_name: Schema.optional(Schema.String),
      }),
    ),
    default_model: Schema.optional(Schema.String),
  }),
);
const decodeKiroModelList = Schema.decodeUnknownOption(KiroModelList);

/**
 * Reads `kiro-cli chat --list-models --format json`, the models the signed-in
 * account may use (Kiro 2.27 lists 20, `auto` first and marked default). The
 * `auto` entry becomes "Kiro default", which leaves the session's model alone.
 * Sessions only advertise a model choice after they start, so this is where
 * the picker learns the list. Anything unparsable keeps the built-in list.
 */
function kiroModelsFromList(
  output: { readonly code: number; readonly stdout: string } | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  if (output === undefined || output.code !== 0) return undefined;
  const list = Option.getOrUndefined(decodeKiroModelList(output.stdout.trim()));
  if (list === undefined || list.models.length === 0) return undefined;
  const defaultId = list.default_model ?? "auto";
  return list.models.map((model) =>
    model.model_id === defaultId
      ? {
          slug: "default",
          name: "Kiro default",
          isCustom: false,
          isDefault: true,
          capabilities: EMPTY_CAPABILITIES,
        }
      : {
          slug: model.model_id,
          name: model.model_name ?? model.model_id,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        },
  );
}

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Kiro is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runKiroCli(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
        : "Failed to run `kiro-cli --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Kiro CLI is installed but failed to run.",
    });
  }

  const whoamiResult = yield* runKiroCli(
    settings,
    ["whoami", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const auth = kiroAuthFromWhoami(
    Result.isSuccess(whoamiResult) ? Option.getOrUndefined(whoamiResult.success) : undefined,
    environment,
  );
  if (auth.status === "unauthenticated") {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth,
      message: "Kiro CLI is installed but not signed in. Run `kiro-cli login`.",
    });
  }
  // Signed out, `--list-models` starts a browser login instead, so it runs
  // only once `whoami` has confirmed the account.
  const listed =
    auth.status === "authenticated"
      ? kiroModelsFromList(
          yield* runKiroCli(
            settings,
            ["chat", "--list-models", "--format", "json"],
            environment,
          ).pipe(
            Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          ),
        )
      : undefined;
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: auth.status === "authenticated" ? "ready" : "warning",
      auth,
      ...(auth.status === "authenticated"
        ? {}
        : { message: "Could not confirm the Kiro sign-in. Run `kiro-cli whoami` to check." }),
    },
    listed,
  );
});
