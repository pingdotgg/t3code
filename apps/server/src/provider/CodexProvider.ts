import { pipe } from "effect/Function";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  CodexSettings,
  CustomModelSetting,
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { PREFERRED_DEFAULT_CODEX_MODELS, ServerSettingsError } from "@t3tools/contracts";

import {
  codexModelFamily,
  createModelCapabilities,
  formatCodexModelName,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  type CodexRateLimitSnapshot,
  type CodexResetCreditsSummary,
} from "./codexUsageLimits.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);
const RATE_LIMITS_PROBE_TIMEOUT_MS = 3_000;

type CodexRateLimitsProbe =
  | {
      readonly snapshot: CodexRateLimitSnapshot;
      readonly rateLimitsByLimitId?:
        | Readonly<Record<string, CodexRateLimitSnapshot>>
        | null
        | undefined;
      readonly resetCredits: CodexResetCreditsSummary | null | undefined;
      readonly accountId?: string | null | undefined;
    }
  | { readonly failure: string };

const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_CATALOG_REFRESH_TIMEOUT_MS = 3_000;
const CODEX_CONFIG_PROBE_TIMEOUT_MS = 3_000;
const CODEX_CATALOG_REFRESH_POLL = "100 millis" as const;
const CODEX_CLIENT_NAME = "T3 Code";
// Handshake plus account/models/skills requests can exceed the shared 10s probe budget.
const CODEX_AUTH_PROBE_TIMEOUT_MS = 20_000;
const CODEX_DISCOVERY_MARGIN_MS = 250;

const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly rateLimits?: CodexRateLimitsProbe;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel> | undefined;
  readonly serviceTier?: string | undefined;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SERVICE_TIER_ID = "default";

const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ultrafast: "Even faster, more expensive",
};

function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;
  return codexPlanLabel(account.planType);
}

export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 200 Subscription";
    case "prolite":
      return "ChatGPT Pro 100 Subscription";
    case "promax":
      return "ChatGPT Pro 500 Subscription";
    case "self_serve_business_prolite":
      return "ChatGPT Business Premium Subscription";
    case "team":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

export function codexDefaultReasoningEffortOverride(model: string): "medium" | undefined {
  return codexModelFamily(model) === "gpt-6-astra" ? "medium" : undefined;
}

export function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort ===
    (codexDefaultReasoningEffortOverride(model.model) ?? model.defaultReasoningEffort)
      ? {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
          isDefault: true,
        }
      : {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
        },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  const catalogDefaultServiceTier = serviceTiers.some(
    (tier) => tier.id === model.defaultServiceTier,
  )
    ? model.defaultServiceTier
    : null;
  const defaultServiceTier = catalogDefaultServiceTier ?? DEFAULT_SERVICE_TIER_ID;
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }
  if (serviceTiers.length > 0) {
    optionDescriptors.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: "Standard",
          ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...serviceTiers.map((tier) => {
          const description = SERVICE_TIER_DESCRIPTIONS[tier.id] ?? tier.description;
          return {
            id: tier.id,
            label: tier.name,
            ...(description ? { description } : {}),
            ...(defaultServiceTier === tier.id ? { isDefault: true } : {}),
          };
        }),
      ],
      currentValue: defaultServiceTier,
    });
  }

  return createModelCapabilities({
    optionDescriptors,
  });
}

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: formatCodexModelName(model.displayName),
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities: mapCodexModelCapabilities(model),
  }));
}

export function applyPreferredCodexDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const preferredSlug = PREFERRED_DEFAULT_CODEX_MODELS.flatMap((slug) =>
    models.filter((model) => !model.isCustom && codexModelFamily(model.slug) === slug),
  )[0]?.slug;
  if (!preferredSlug) {
    return models;
  }
  return models.map((model) => {
    if (model.slug === preferredSlug) {
      return model.isDefault ? model : { ...model, isDefault: true };
    }
    if (!model.isDefault) {
      return model;
    }
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
}

function applyConfiguredCodexServiceTier(
  models: ReadonlyArray<ServerProviderModel>,
  serviceTier: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!serviceTier) return models;
  return models.map((model) => {
    if (!model.capabilities?.optionDescriptors) return model;
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: model.capabilities.optionDescriptors.map((descriptor) => {
          if (descriptor.id !== "serviceTier" || descriptor.type !== "select") return descriptor;
          const value = descriptor.options.find(
            (option) =>
              option.id === serviceTier || (serviceTier === "fast" && option.id === "priority"),
          )?.id;
          if (!value) return descriptor;
          return {
            ...descriptor,
            currentValue: value,
            options: descriptor.options.map(({ isDefault: _isDefault, ...option }) =>
              option.id === value ? { ...option, isDefault: true } : option,
            ),
          };
        }),
      },
    };
  });
}

/**
 * Codex has no static default capability set, so a bare custom slug borrows
 * the first built-in's descriptors; an entry with its own capabilities keeps
 * them.
 */
function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  return providerModelsFromSettings(models, customModels, fallbackCapabilities);
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

const decodeCodexModelsCacheStamp = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ fetched_at: Schema.String })),
);

const readCodexModelsCacheFetchedAt = Effect.fn("readCodexModelsCacheFetchedAt")(function* (
  codexHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(codexHome, "models_cache.json"))
    .pipe(Effect.option);
  return Option.flatMap(text, decodeCodexModelsCacheStamp).pipe(
    Option.flatMap((stamp) => DateTime.make(stamp.fetched_at)),
    Option.match({ onNone: () => Number.NaN, onSome: DateTime.toEpochMillis }),
  );
});

const withCodexDiscoveryDeadline = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadlineMs: number,
  timeoutMs = Infinity,
) {
  const remainingMs = Math.min(timeoutMs, deadlineMs - DateTime.toEpochMillis(yield* DateTime.now));
  if (remainingMs <= 0) return undefined;
  return yield* effect.pipe(
    Effect.timeoutOption(Duration.millis(remainingMs)),
    Effect.map(Option.getOrUndefined),
  );
});

/**
 * Every Codex client on the machine shares that file, and the backend tailors
 * the catalog to each client's originator: the plain CLI does not get Sol
 * Ultrafast. App-server refreshes the catalog online at startup, so wait until
 * a write newer than this process's spawn lands, then list again.
 */
const requestCodexChatGptModels = Effect.fn("requestCodexChatGptModels")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly codexHome: string;
  readonly spawnedAtMs: number;
  readonly deadlineMs: number;
}) {
  const models = yield* withCodexDiscoveryDeadline(
    requestAllCodexModels(input.client),
    input.deadlineMs,
  );
  if (models === undefined) return undefined;
  const refreshed = yield* withCodexDiscoveryDeadline(
    readCodexModelsCacheFetchedAt(input.codexHome).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(CODEX_CATALOG_REFRESH_POLL),
        until: (fetchedAtMs) => fetchedAtMs >= input.spawnedAtMs,
      }),
    ),
    input.deadlineMs,
    CODEX_CATALOG_REFRESH_TIMEOUT_MS,
  );
  if (refreshed === undefined) {
    yield* Effect.logWarning(
      "Codex did not refresh its model catalog in time; using the cached catalog.",
    );
    return models;
  }
  return (
    (yield* withCodexDiscoveryDeadline(requestAllCodexModels(input.client), input.deadlineMs)) ??
    models
  );
});

/** Set originator at spawn; the pre-initialize refresh otherwise overwrites shared cache with plain-CLI models. */
export const codexAppServerEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => ({
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_CLIENT_NAME,
  ...environment,
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: CODEX_CLIENT_NAME,
      title: CODEX_CLIENT_NAME,
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

export const withCodexAppServerClient = Effect.fn("withCodexAppServerClient")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly launchArgs?: string | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}) {
  // Expand CODEX_HOME explicitly: spawn passes a literal ~ that Codex rejects.
  const resolvedHomePath = input.homePath
    ? expandHomePath(input.homePath, yield* HostProcess.HomeDirectory)
    : undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = {
    ...codexAppServerEnvironment(
      input.environment ?? (yield* mergeProviderInstanceEnvironment(undefined)),
    ),
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    codexAppServerArgs(input.launchArgs),
    { env: environment },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
  const initialize = yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);
  return { client, initialize };
});

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly skipNativeUsage?: boolean;
}) {
  const spawnedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
  const { client, initialize } = yield* withCodexAppServerClient(input);

  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  const accountResponse = yield* client.request("account/read", {});
  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    return {
      account: accountResponse,
      version,
      models: [],
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  // Optional discovery must finish before the outer timeout can discard the account result.
  const deadlineMs = spawnedAtMs + CODEX_AUTH_PROBE_TIMEOUT_MS - CODEX_DISCOVERY_MARGIN_MS;
  const [skillsResponse, models, serviceTier, rateLimits] = yield* Effect.all(
    [
      withCodexDiscoveryDeadline(client.request("skills/list", { cwds: [input.cwd] }), deadlineMs),
      accountResponse.account?.type === "chatgpt"
        ? requestCodexChatGptModels({
            client,
            codexHome: initialize.codexHome,
            spawnedAtMs,
            deadlineMs,
          })
        : withCodexDiscoveryDeadline(requestAllCodexModels(client), deadlineMs),
      // The shared catalog must exclude config from the server's launch project.
      withCodexDiscoveryDeadline(
        client.request("config/read", { includeLayers: false }),
        deadlineMs,
        CODEX_CONFIG_PROBE_TIMEOUT_MS,
      ).pipe(
        Effect.map((response) => response?.config.service_tier ?? undefined),
        Effect.catch(() => Effect.logDebug("Codex config read failed.").pipe(Effect.as(undefined))),
      ),
      // Usage is an enrichment: a failure or a slow answer degrades to "no
      // usage this probe" rather than costing the account and models.
      input.skipNativeUsage
        ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
          Effect.succeed(undefined)
        : withCodexDiscoveryDeadline(
            client.request("account/rateLimits/read", null),
            deadlineMs,
            RATE_LIMITS_PROBE_TIMEOUT_MS,
          ).pipe(
            Effect.map((response): CodexRateLimitsProbe =>
              response
                ? {
                    snapshot: response.rateLimits,
                    rateLimitsByLimitId: response.rateLimitsByLimitId,
                    resetCredits: response.rateLimitResetCredits,
                    accountId: response.accountId,
                  }
                : { failure: "Codex did not answer the usage request." },
            ),
            Effect.catch((error) =>
              Effect.logDebug("Codex rate-limit read failed.", { cause: error }).pipe(
                Effect.as<CodexRateLimitsProbe>({ failure: codexRateLimitsFailureMessage(error) }),
              ),
            ),
          ),
    ],
    { concurrency: "unbounded" },
  );

  return {
    account: accountResponse,
    ...(rateLimits ? { rateLimits } : {}),
    version,
    models,
    serviceTier,
    skills: skillsResponse ? parseCodexSkillsListResponse(skillsResponse, input.cwd) : [],
  } satisfies CodexAppServerProviderSnapshot;
});

export const probeCodexSkillsForCwd = Effect.fn("probeCodexSkillsForCwd")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const { client } = yield* withCodexAppServerClient(input);
  const skillsResponse = yield* client.request("skills/list", { cwds: [input.cwd] });
  return parseCodexSkillsListResponse(skillsResponse, input.cwd);
});

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  appendCustomCodexModels([], codexSettings.customModels);

const makePendingCodexProvider = Effect.fn("CodexProvider.makePendingCodexProvider")(function* (
  codexSettings: CodexSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Codex provider status has not been checked in this session yet.",
    },
  });
});

function accountProbeStatus({ account, rateLimits }: CodexAppServerProviderSnapshot): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(account.account);
  const authEmail = codexAccountEmail(account.account);
  const workspaceId =
    rateLimits && "accountId" in rateLimits ? rateLimits.accountId?.trim() : undefined;
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly launchArgs?: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly skipNativeUsage?: boolean;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
  > = probeCodexAppServerProvider,
  environment?: NodeJS.ProcessEnv,
  managedAuth?: ServerProvider["auth"],
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? (yield* mergeProviderInstanceEnvironment(undefined));
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in T3 Code settings.",
      },
    });
  }

  const probeResult = yield* probe({
    binaryPath: codexSettings.binaryPath,
    homePath: codexSettings.homePath,
    launchArgs: resolveCodexLaunchArgs(codexSettings.launchArgs, resolvedEnvironment),
    cwd: process.cwd(),
    environment: resolvedEnvironment,
    ...(managedAuth ? { skipNativeUsage: true } : {}),
  }).pipe(
    // Process teardown can outlast the work budget without discarding a completed snapshot.
    Effect.timeoutOption(Duration.millis(CODEX_AUTH_PROBE_TIMEOUT_MS)),
    Effect.scoped,
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    const installed = !isCodexAppServerSpawnError(error);
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? `Codex app-server provider probe failed: ${error.message}.`
          : `Could not start Codex CLI (\`${codexSettings.binaryPath}\`). Check Settings → Providers → Codex → Binary path on the server.` +
            (codexSettings.binaryPath === "codex"
              ? " Installing ChatGPT or Codex desktop may not add codex to PATH."
              : " Make sure the configured executable exists and can be run."),
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  const accountStatus = managedAuth
    ? { status: "ready" as const, auth: managedAuth, message: undefined }
    : accountProbeStatus(snapshot);
  const usageLimits =
    snapshot.account.account?.type === "apiKey"
      ? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
      : snapshot.rateLimits === undefined || "failure" in snapshot.rateLimits
        ? makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            ...(accountStatus.message ? { message: accountStatus.message } : {}),
            ...(snapshot.rateLimits ? { message: snapshot.rateLimits.failure } : {}),
          })
        : codexRateLimitsToLimits({
            snapshot: snapshot.rateLimits.snapshot,
            rateLimitsByLimitId: snapshot.rateLimits.rateLimitsByLimitId,
            resetCredits: snapshot.rateLimits.resetCredits,
            checkedAt,
          });

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models: pipe(
      appendCustomCodexModels(snapshot.models ?? [], codexSettings.customModels),
      applyPreferredCodexDefaultModel,
      (models) => applyConfiguredCodexServiceTier(models, snapshot.serviceTier),
    ),
    skills: snapshot.skills,
    slashCommands: [
      COMPACT_SLASH_COMMAND,
      {
        name: "goal",
        description: "Set a goal Codex keeps working toward until it is done",
        input: { hint: "Objective, or pause, resume, clear" },
      },
      {
        name: "feedback",
        description: "Send this thread and Codex logs to OpenAI",
        input: { hint: "Describe the issue (optional)" },
      },
    ],
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: snapshot.models === undefined ? "warning" : accountStatus.status,
      auth: accountStatus.auth,
      ...(accountStatus.message
        ? { message: accountStatus.message }
        : snapshot.models === undefined
          ? { message: "Codex did not return its model catalog in time." }
          : {}),
      ...(managedAuth ? {} : { usageLimits }),
    },
  });
});

export { makePendingCodexProvider };
