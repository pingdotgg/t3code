import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { KiroSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  KIRO_AGENT_CONFIG_ID,
  KIRO_SUPPORTED_RUNTIME_MODES,
  makeKiroAcpRuntime,
} from "./acpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
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

/**
 * The agent picker is not a model trait, but the composer reads options per
 * model, so every model, custom ones included, carries it.
 */
const kiroModels = (
  settings: KiroSettings,
  listed: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
  agents?: ProviderOptionDescriptor,
) =>
  providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES).map((model) => {
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    return agents === undefined || descriptors.some((descriptor) => descriptor.id === agents.id)
      ? model
      : {
          ...model,
          capabilities: createModelCapabilities({ optionDescriptors: [...descriptors, agents] }),
        };
  });

const snapshot = (
  settings: KiroSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed?: ReadonlyArray<ServerProviderModel>,
  agents?: ProviderOptionDescriptor,
) =>
  buildServerProvider({
    // Gives the snapshot its version advisory; Kiro runs no enrichment pass.
    driver: KIRO_DRIVER_KIND,
    presentation: KIRO_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: kiroModels(settings, listed, agents),
    // `/compact` runs `_kiro/session/compact`; see compactKiroSession.
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe,
  });

export const buildInitialKiroProviderSnapshot = Effect.fn(
  "KiroProvider.buildInitialKiroProviderSnapshot",
)(function* (settings: KiroSettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking Kiro CLI availability..."
      : "Kiro is disabled in T3 Code settings.",
  });
});

const runKiroCli = Effect.fn("KiroProvider.runKiroCli")(function* (
  settings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
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
 * Reads `kiro-cli whoami --format json`: `{"account":null}` with exit 1 means
 * signed out. Only the first line is decoded, since an Identity Center login
 * follows it with a plain-text `Profile:` block.
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
const KIMI_K3_EFFORT_LEVELS = ["low", "high", "max"];

/**
 * Reasoning levels per Kiro model id and its default level, copied from what
 * Kiro 2.32.0 advertises, since `--list-models` names none. Unlisted models take
 * no effort; the adapter sends only a level the live session offers.
 */
const KIRO_MODEL_EFFORT: Readonly<
  Record<string, { readonly levels: ReadonlyArray<string>; readonly defaultLevel: string }>
> = {
  "claude-fable-5.1": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
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
  "kimi-k3": { levels: KIMI_K3_EFFORT_LEVELS, defaultLevel: "max" },
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
 * Reads `kiro-cli chat --list-models --format json`, the account's models. The
 * default entry keeps its name but takes the "default" slug, with Kiro's id as its
 * alias. Sessions advertise models only after they start; anything unparsable
 * keeps the built-in list.
 */
function kiroModelsFromList(
  output: { readonly code: number; readonly stdout: string } | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  if (output === undefined || output.code !== 0) return undefined;
  const list = Option.getOrUndefined(decodeKiroModelList(output.stdout.trim()));
  if (list === undefined || list.models.length === 0) return undefined;
  const defaultId = list.default_model ?? KIRO_FALLBACK_DEFAULT_MODEL;
  const listedDefault = list.models.find((model) => model.model_id === defaultId);
  const defaultModel: ServerProviderModel = {
    slug: KIRO_DEFAULT_MODEL_SLUG,
    // Named after the model it runs, so a named default isn't hidden behind "Kiro default".
    name: listedDefault ? (listedDefault.model_name ?? listedDefault.model_id) : "Kiro default",
    aliases: [defaultId],
    isCustom: false,
    isDefault: true,
    // A new session on Kiro's default gets no model write, so Kiro never
    // advertises its effort option and a level could not be applied.
    capabilities: EMPTY_CAPABILITIES,
  };
  const models = list.models.map((model) =>
    model === listedDefault
      ? defaultModel
      : {
          slug: model.model_id,
          name: model.model_name ?? model.model_id,
          isCustom: false,
          capabilities: kiroModelCapabilities(model.model_id),
        },
  );
  // New threads select "default", so it is listed even when Kiro's list leaves its default out.
  return models.includes(defaultModel) ? models : [defaultModel, ...models];
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

const KiroConfigTemplate = Schema.Struct({
  configOptions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      currentValue: Schema.optional(Schema.Unknown),
      options: Schema.optional(
        Schema.Array(
          Schema.Struct({
            value: Schema.String,
            name: Schema.String,
            description: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});
const decodeKiroConfigTemplate = Schema.decodeUnknownOption(KiroConfigTemplate);

/**
 * The thread's agent picker, from Kiro's `_kiro/config/template` result, without
 * opening a session. The template reads no workspace, so a project's
 * `.kiro/agents` are not offered.
 */
export function kiroAgentDescriptor(template: unknown): ProviderOptionDescriptor | undefined {
  const decoded = Option.getOrUndefined(decodeKiroConfigTemplate(template));
  const mode = decoded?.configOptions.find(
    (option) => option.id === KIRO_AGENT_CONFIG_ID && option.type === "select",
  );
  const defaultAgent = typeof mode?.currentValue === "string" ? mode.currentValue : undefined;
  const choices = (mode?.options ?? []).flatMap((choice) => {
    const id = choice.value.trim();
    const label = choice.name.trim() || id;
    const description = choice.description?.trim();
    return id.length === 0
      ? []
      : [
          {
            id,
            label,
            ...(description ? { description } : {}),
            ...(id === defaultAgent ? { isDefault: true } : {}),
          },
        ];
  });
  // One agent is nothing to choose between.
  if (choices.length < 2) return undefined;
  return {
    id: KIRO_AGENT_CONFIG_ID,
    label: "Agent",
    type: "select",
    options: choices,
    ...(defaultAgent !== undefined && choices.some((choice) => choice.isDefault)
      ? { currentValue: defaultAgent }
      : {}),
  };
}

/**
 * Asks Kiro for its agents with `initialize` and `_kiro/config/template` and
 * nothing more: no `session/new`, so no MCP server starts and no session is
 * stored. The process runs in the server's working directory.
 */
const probeKiroAgents = Effect.fn("KiroProvider.probeKiroAgents")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
) {
  const runtime = yield* makeKiroAcpRuntime({
    settings,
    environment,
    cwd: yield* HostProcess.WorkingDirectory,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
  });
  yield* runtime.initialize();
  return kiroAgentDescriptor(yield* runtime.request("_kiro/config/template", {}));
}, Effect.scoped);

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
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
  // Signed out, `--list-models` starts a browser login instead, and the agent
  // probe fails to start, so both run only once `whoami` has confirmed the
  // account. Without an agent list the composer shows no agent picker.
  const [listed, agents] =
    auth.status === "authenticated"
      ? yield* Effect.all(
          [
            runKiroCli(settings, ["chat", "--list-models", "--format", "json"], environment).pipe(
              Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
              Effect.map((output) => kiroModelsFromList(Option.getOrUndefined(output))),
              Effect.orElseSucceed(() => undefined),
            ),
            probeKiroAgents(settings, environment).pipe(
              Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
              Effect.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            ),
          ],
          { concurrency: "unbounded" },
        )
      : [undefined, undefined];
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
    agents,
  );
});
