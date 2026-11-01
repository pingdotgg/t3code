import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type AntigravitySettings,
  type ProviderSetupError,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { resolveUsageLimitsAfterProbe } from "@t3tools/provider-core/server/usageLimits";

import { antigravityThinkingConfig } from "./acp/AntigravityAcpSupport.ts";

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAX_WORKSPACE_SNAPSHOTS = 32;
const HEALTH_CHECK_TIMEOUT = "90 seconds";
const SIGN_IN_MESSAGE = "Sign in with Google to use Antigravity.";
const AUTH_UNCHECKED_MESSAGE =
  "Antigravity is installed. Google account access is not checked yet.";

type SessionSetupResult = Pick<
  AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
  "configOptions" | "models"
>;

type ThinkingConfig = NonNullable<ReturnType<typeof antigravityThinkingConfig>>;

/** Thinking options each model reported when selected; `null` means it has none. */
export type AntigravityThinkingLevels = ReadonlyMap<string, ThinkingConfig | null>;

function thinkingCapabilities(config: ThinkingConfig | null | undefined, observed: boolean) {
  const descriptor = config
    ? acpProviderOptionDescriptors({ configOptions: [config], modeState: undefined })[0]
    : undefined;
  if (descriptor?.type !== "select") return EMPTY_MODEL_CAPABILITIES;
  // Another model's selected level is not this model's default.
  const { currentValue: _currentValue, ...unobserved } = descriptor;
  return createModelCapabilities({ optionDescriptors: [observed ? descriptor : unobserved] });
}

export function buildAntigravityModelsFromSession(
  setup: SessionSetupResult,
  thinkingLevels: AntigravityThinkingLevels = new Map(),
): ReadonlyArray<ServerProviderModel> {
  const config = setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const currentValue =
    config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
  const entries =
    config?.type === "select"
      ? config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : config === undefined
        ? (setup.models?.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
          })) ?? [])
        : [];
  const currentThinking = antigravityThinkingConfig(setup.configOptions);
  const seen = new Set<string>();
  // The agent can list two IDs under one name; label the later ones so the picker tells them apart.
  const names = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    if (!entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    const baseName = entry.name.trim() ? entry.name : entry.value;
    const name = names.has(baseName) ? `${baseName} (${entry.value})` : baseName;
    names.add(baseName);
    const observed =
      entry.value === currentValue ? (currentThinking ?? null) : thinkingLevels.get(entry.value);
    return [
      {
        slug: entry.value,
        name,
        isCustom: false,
        ...(entry.value === currentValue
          ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] }
          : {}),
        capabilities:
          observed === undefined
            ? thinkingCapabilities(currentThinking, false)
            : thinkingCapabilities(observed, true),
      },
    ];
  });
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

function isMissingInstallation(error: EffectAcpErrors.AcpError | ProviderSetupError): boolean {
  if (error._tag === "AcpSpawnError") {
    return (
      isCommandMissingCause(error.cause) ||
      (Predicate.isObject(error.cause) && error.cause.code === "ENOENT")
    );
  }
  return (
    error._tag === "ProviderSetupError" &&
    error.operation === "resolve" &&
    /not installed|missing|incomplete|does not publish/i.test(error.detail)
  );
}

interface AntigravityProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

interface AntigravityProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly probeUsage?: Effect.Effect<ServerProviderUsageLimits>;
  readonly clearUsage?: Effect.Effect<void>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
  readonly auth?: { readonly type: string; readonly label: string };
}

export const makeAntigravityProvider = Effect.fn("makeAntigravityProvider")(function* (
  settings: AntigravitySettings,
  options: AntigravityProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: { displayName: "Antigravity", showInteractionModeToggle: false },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown", ...(options.auth ? { type: options.auth.type } : {}) },
        message: settings.enabled
          ? "Checking Antigravity availability."
          : "Antigravity is disabled in T3 Code settings.",
      },
    }),
    setup: { canAuthenticate: true, canInstall: true },
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    workspaceSnapshots: [],
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<AntigravityProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  // Preserve disk-discovered skills when callbacks replace workspace commands; the registry will not rescan them.
  const discoveredSkills = new Map<string, ServerProvider["skills"]>();
  const thinkingLevels = new Map<string, ThinkingConfig | null>();
  const observeThinkingLevels = (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  ) => {
    const model = configOptions?.find(
      (option) => option.id === "model" || option.category === "model",
    );
    if (model?.type === "select" && model.currentValue) {
      thinkingLevels.set(model.currentValue, antigravityThinkingConfig(configOptions) ?? null);
    }
  };
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkAntigravityProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    const result = yield* options.probe.pipe(
      Effect.timeoutOption(HEALTH_CHECK_TIMEOUT),
      Effect.result,
    );
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const version = initialized?.agentInfo?.version;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const errorMessage =
      initialized !== undefined
        ? undefined
        : failure?._tag === "ProviderSetupError"
          ? failure.detail.trim() || "Antigravity could not complete its local health check."
          : missingInstallation
            ? "Antigravity ACP runtime is not installed or its executable could not be found."
            : failure
              ? "Antigravity could not complete its local health check."
              : `Antigravity did not respond to its local health check within ${HEALTH_CHECK_TIMEOUT}.`;
    const supportsTextGeneration =
      initialized !== undefined ? yield* options.supportsTextGeneration : false;
    const usageLimits =
      initialized !== undefined && options.probeUsage ? yield* options.probeUsage : undefined;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      const authenticated = draft.auth.status === "authenticated";
      const message =
        errorMessage ??
        (authenticated
          ? undefined
          : draft.auth.status === "unauthenticated"
            ? SIGN_IN_MESSAGE
            : AUTH_UNCHECKED_MESSAGE);
      return {
        ...state,
        draft: {
          ...draft,
          installed: !missingInstallation,
          // Lightweight custom-launcher probes lack versions; preserve the real handshake's version.
          version: version === "unknown" ? draft.version : version || draft.version,
          status: errorMessage ? "error" : authenticated ? "ready" : "warning",
          checkedAt: updatedAt,
          usageLimits: missingInstallation
            ? undefined
            : resolveUsageLimitsAfterProbe({
                published: draft.usageLimits,
                probed: usageLimits ?? draft.usageLimits,
              }),
          ...(missingInstallation
            ? {
                models: [],
                slashCommands: [],
                skills: [],
                workspaceSnapshots: [],
                supportsTextGeneration: false,
              }
            : {}),
          ...(initialized !== undefined
            ? {
                supportsTextGeneration:
                  supportsTextGeneration && draft.auth.status !== "unauthenticated",
              }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies AntigravityProviderState;
    });
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("antigravity"),
      packageName: null,
    });
  const managed = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
    enrichSnapshot: ({ publishSnapshot }) =>
      SubscriptionRef.changes(metadata).pipe(
        Stream.runForEach((state) =>
          options.stampIdentity(state.draft).pipe(Effect.flatMap(publishSnapshot)),
        ),
      ),
  });

  const onSessionStarted = Effect.fn("AntigravityProvider.onSessionStarted")(function* (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd?: string,
  ) {
    if (!settings.enabled) return;
    observeThinkingLevels(started.sessionSetupResult.configOptions);
    const before = yield* SubscriptionRef.get(metadata);
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const usageLimits =
      options.probeUsage && (!before.draft.usageLimits || before.draft.usageLimits.unavailable)
        ? yield* options.probeUsage
        : before.draft.usageLimits;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (
        state.authRevision !== before.authRevision &&
        state.draft.auth.status === "unauthenticated"
      ) {
        return state;
      }
      const { message: _previousMessage, ...draft } = state.draft;
      const workspaces = draft.workspaceSnapshots ?? [];
      const workspace = cwd ? workspaces.find((entry) => entry.cwd === cwd) : undefined;
      return {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: "ready",
          version: started.initializeResult.agentInfo?.version || draft.version,
          auth: {
            status: "authenticated",
            type: options.auth?.type ?? "oauth-personal",
            label: options.auth?.label ?? "Google account",
          },
          checkedAt: updatedAt,
          usageLimits: resolveUsageLimitsAfterProbe({
            published: draft.usageLimits,
            probed: usageLimits ?? draft.usageLimits,
          }),
          models: buildAntigravityModelsFromSession(started.sessionSetupResult, thinkingLevels),
          supportsTextGeneration,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...workspaces.filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands: workspace?.slashCommands ?? draft.slashCommands,
                    skills: workspace?.skills ?? discoveredSkills.get(cwd) ?? [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      } satisfies AntigravityProviderState;
    });
  });

  const onConfigOptionsUpdated = Effect.fn("AntigravityProvider.onConfigOptionsUpdated")(function* (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) {
    observeThinkingLevels(configOptions);
    const models = buildAntigravityModelsFromSession({ configOptions }, thinkingLevels);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status !== "authenticated") return state;
      return { ...state, draft: { ...state.draft, models } };
    });
  });

  const onAvailableCommands = Effect.fn("AntigravityProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd?: string,
  ) {
    if (!settings.enabled) return;
    const slashCommands = nativeCommands(commands);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status === "unauthenticated") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          slashCommands,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...(state.draft.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands,
                    skills:
                      state.draft.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills ??
                      discoveredSkills.get(cwd) ??
                      [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      };
    });
  });

  const clearAccountMetadata = Effect.fn("AntigravityProvider.clearAccountMetadata")(function* () {
    if (options.clearUsage) yield* options.clearUsage;
    if (!settings.enabled) return;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(
      metadata,
      (state) =>
        ({
          authRevision: state.authRevision + 1,
          draft: {
            ...state.draft,
            auth: { status: "unauthenticated" },
            status: "warning",
            message: SIGN_IN_MESSAGE,
            checkedAt: updatedAt,
            models: [],
            slashCommands: [],
            skills: [],
            workspaceSnapshots: [],
            supportsTextGeneration: false,
            usageLimits: undefined,
          },
        }) satisfies AntigravityProviderState,
    );
    discoveredSkills.clear();
    thinkingLevels.clear();
  });

  const snapshotForCwd = Effect.fn("AntigravityProvider.snapshotForCwd")(function* (
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    if (skills) {
      discoveredSkills.set(cwd, skills);
      yield* SubscriptionRef.update(metadata, (state) =>
        state.draft.workspaceSnapshots?.some((entry) => entry.cwd === cwd)
          ? {
              ...state,
              draft: {
                ...state.draft,
                workspaceSnapshots: state.draft.workspaceSnapshots.map((entry) =>
                  entry.cwd === cwd ? { ...entry, skills } : entry,
                ),
              },
            }
          : state,
      );
    }
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    const resolvedSkills = skills ?? workspace?.skills ?? discoveredSkills.get(cwd) ?? [];
    return workspace
      ? { ...snapshot, slashCommands: workspace.slashCommands, skills: resolvedSkills }
      : { ...snapshot, skills: resolvedSkills };
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onConfigOptionsUpdated,
    onAvailableCommands,
    onSignedOut: clearAccountMetadata(),
    onAuthRequired: clearAccountMetadata(),
    snapshotForCwd,
  };
});
