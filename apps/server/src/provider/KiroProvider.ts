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
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { KIRO_SUPPORTED_RUNTIME_MODES } from "./acp/KiroAcpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  buildSelectOptionDescriptor,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");
const KIRO_PRESENTATION = {
  displayName: "Kiro",
  showInteractionModeToggle: false,
  supportedRuntimeModes: KIRO_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const KIRO_DEFAULT_MODEL_SLUG = "default";
const KIRO_FALLBACK_DEFAULT_MODEL = "auto";
const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIRO_DEFAULT_MODEL_SLUG,
    name: "Kiro default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
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
 * `KIRO_API_KEY` is set), and `{"account":null}` with exit 1 when not. An IAM
 * Identity Center login follows the JSON line with a plain-text `Profile:`
 * block, so only the first line is decoded.
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
  const firstLine = output.stdout.trimStart().split("\n", 1)[0] ?? "";
  const account = Option.getOrUndefined(decodeKiroWhoami(firstLine.trim()));
  if (account?.accountType === "ApiKey" || environment[KIRO_API_KEY_ENV]?.trim()) {
    return { status: "authenticated", type: "api_key", label: "Kiro API key" };
  }
  return {
    status: "authenticated",
    label: "Kiro account",
    ...(account?.email ? { email: account.email } : {}),
  };
}

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_4_6_EFFORT_LEVELS = ["low", "medium", "high", "max"];
const GPT_5_6_EFFORT_LEVELS = ["none", ...CLAUDE_EFFORT_LEVELS];

/**
 * Reasoning levels per Kiro model id, and the one Kiro runs it at by default.
 * `--list-models` names no levels, and a session advertises them (the `model`
 * option's `_meta.kiro.effortLevels` and `defaultEffortLevel`) only once it
 * runs, so the picker uses this copy of Kiro 2.27.0's choices
 * (fixtures/kiro_model_switch), which match kiro.dev/docs/models/effort.
 * Models not listed take no effort. The adapter sends only a level the live
 * session offers, so a stale entry never reaches Kiro.
 */
const KIRO_MODEL_EFFORT: Readonly<
  Record<string, { readonly levels: ReadonlyArray<string>; readonly defaultLevel: string }>
> = {
  "claude-opus-5.5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "medium" },
  "claude-opus-5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-opus-4.8": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-opus-4.7": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "xhigh" },
  "claude-opus-4.6": { levels: CLAUDE_4_6_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-sonnet-5.5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-sonnet-5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-sonnet-4.6": { levels: CLAUDE_4_6_EFFORT_LEVELS, defaultLevel: "high" },
  "gpt-5.6-sol": { levels: GPT_5_6_EFFORT_LEVELS, defaultLevel: "high" },
  "gpt-5.6-terra": { levels: GPT_5_6_EFFORT_LEVELS, defaultLevel: "high" },
  "gpt-5.6-luna": { levels: GPT_5_6_EFFORT_LEVELS, defaultLevel: "high" },
};
const KIRO_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function kiroModelCapabilities(modelId: string): ModelCapabilities {
  const effort = KIRO_MODEL_EFFORT[modelId];
  if (effort === undefined) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: effort.levels.map((level) => ({
          value: level,
          label: KIRO_EFFORT_LABELS[level] ?? level,
          isDefault: level === effort.defaultLevel,
        })),
      }),
    ],
  });
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
 * default entry becomes "Kiro default" and keeps Kiro's own id as its alias,
 * which the adapter selects for it. Sessions only advertise a model choice
 * after they start, so this is where the picker learns the list. Anything
 * unparsable keeps the built-in list.
 */
function kiroModelsFromList(
  output: { readonly code: number; readonly stdout: string } | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  if (output === undefined || output.code !== 0) return undefined;
  const list = Option.getOrUndefined(decodeKiroModelList(output.stdout.trim()));
  if (list === undefined || list.models.length === 0) return undefined;
  const defaultId = list.default_model ?? KIRO_FALLBACK_DEFAULT_MODEL;
  return list.models.map((model) =>
    model.model_id === defaultId
      ? {
          slug: KIRO_DEFAULT_MODEL_SLUG,
          name: "Kiro default",
          aliases: [model.model_id],
          isCustom: false,
          isDefault: true,
          // A new session on Kiro's default gets no model write, so Kiro never
          // advertises its effort option and a level could not be applied.
          capabilities: EMPTY_CAPABILITIES,
        }
      : {
          slug: model.model_id,
          name: model.model_name ?? model.model_id,
          isCustom: false,
          capabilities: kiroModelCapabilities(model.model_id),
        },
  );
}

/**
 * Kiro's own id for "Kiro default": the alias the model list gave it, else
 * `auto`, Kiro's documented default.
 */
export function kiroDefaultModelId(models: ReadonlyArray<ServerProviderModel>): string {
  return (
    models.find((model) => model.slug === KIRO_DEFAULT_MODEL_SLUG)?.aliases?.[0] ??
    KIRO_FALLBACK_DEFAULT_MODEL
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
