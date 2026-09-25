import {
  PRIME_AGENT_DEFAULT_MODEL,
  ProviderDriverKind,
  type PrimeAgentSettings,
  type ProviderSetupError,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
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
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DRIVER = ProviderDriverKind.make("primeAgent");
const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAX_WORKSPACE_SNAPSHOTS = 32;
const HEALTH_CHECK_TIMEOUT = "20 seconds";
const AUTH_UNCHECKED_MESSAGE =
  "Prime Agent is installed. Its credentials come from the environment or its own login.";

type SessionSetupResult = Pick<
  AcpSessionRuntimeStartResult["sessionSetupResult"],
  "configOptions" | "models"
>;

export function buildPrimeAgentModelsFromSession(
  setup: SessionSetupResult,
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
  const seen = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    if (!entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    return [
      {
        slug: entry.value,
        name: entry.name.trim() ? entry.name : entry.value,
        isCustom: false,
        ...(entry.value === currentValue
          ? { isDefault: true, aliases: [PRIME_AGENT_DEFAULT_MODEL] }
          : {}),
        capabilities: EMPTY_MODEL_CAPABILITIES,
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

interface PrimeAgentProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

interface PrimeAgentProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => ServerProvider;
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}

export const makePrimeAgentProvider = Effect.fn("makePrimeAgentProvider")(function* (
  settings: PrimeAgentSettings,
  options: PrimeAgentProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: { displayName: "Prime Agent", showInteractionModeToggle: false },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Prime Agent availability."
          : "Prime Agent is disabled in T3 Code settings.",
      },
    }),
    setup: { canAuthenticate: false, canInstall: false },
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    workspaceSnapshots: [],
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<PrimeAgentProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.map((state) => options.stampIdentity(state.draft)),
  );

  const checkProvider = Effect.fn("checkPrimeAgentProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    const result = yield* options.probe.pipe(
      Effect.timeoutOption(HEALTH_CHECK_TIMEOUT),
      Effect.result,
    );
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const errorMessage =
      initialized !== undefined
        ? undefined
        : failure?._tag === "ProviderSetupError"
          ? failure.detail.trim() || "Prime Agent could not complete its local health check."
          : missingInstallation
            ? "Prime Agent is not installed or its executable could not be found."
            : failure
              ? "Prime Agent could not complete its local health check."
              : `Prime Agent did not respond to its local health check within ${HEALTH_CHECK_TIMEOUT}.`;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (state) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      const message =
        errorMessage ??
        (draft.auth.status === "authenticated" ? undefined : AUTH_UNCHECKED_MESSAGE);
      return {
        ...state,
        draft: {
          ...draft,
          installed: !missingInstallation,
          version: initialized?.agentInfo?.version || draft.version,
          status: errorMessage
            ? "error"
            : draft.auth.status === "authenticated"
              ? "ready"
              : "warning",
          checkedAt: updatedAt,
          ...(missingInstallation
            ? {
                models: [],
                slashCommands: [],
                skills: [],
                workspaceSnapshots: [],
                supportsTextGeneration: false,
              }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies PrimeAgentProviderState;
    });
    return yield* Effect.sync(() => options.stampIdentity(next.draft));
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER,
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
          Effect.flatMap(
            Effect.sync(() => options.stampIdentity(state.draft)),
            (snapshot) => publishSnapshot(snapshot),
          ),
        ),
      ),
  });

  const onSessionStarted = Effect.fn("PrimeAgentProvider.onSessionStarted")(function* (
    started: AcpSessionRuntimeStartResult,
    cwd?: string,
  ) {
    const before = yield* SubscriptionRef.get(metadata);
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
          status: settings.enabled ? "ready" : "disabled",
          version: started.initializeResult.agentInfo?.version || draft.version,
          checkedAt: updatedAt,
          models: buildPrimeAgentModelsFromSession(started.sessionSetupResult),
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...workspaces.filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands: workspace?.slashCommands ?? draft.slashCommands,
                    skills: workspace?.skills ?? [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      } satisfies PrimeAgentProviderState;
    });
  });

  const onConfigOptionsUpdated = Effect.fn("PrimeAgentProvider.onConfigOptionsUpdated")(function* (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) {
    const models = buildPrimeAgentModelsFromSession({ configOptions });
    yield* SubscriptionRef.update(metadata, (state) => ({
      ...state,
      draft: { ...state.draft, models },
    }));
  });

  const onAvailableCommands = Effect.fn("PrimeAgentProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd?: string,
  ) {
    const slashCommands = nativeCommands(commands);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => ({
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
                    [],
                },
              ].slice(-MAX_WORKSPACE_SNAPSHOTS),
            }
          : {}),
      },
    }));
  });

  const clearAccountMetadata = Effect.fn("PrimeAgentProvider.clearAccountMetadata")(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(
      metadata,
      (state) =>
        ({
          authRevision: state.authRevision + 1,
          draft: {
            ...state.draft,
            status: settings.enabled ? "warning" : "disabled",
            message: AUTH_UNCHECKED_MESSAGE,
            checkedAt: updatedAt,
            models: [],
            slashCommands: [],
            skills: [],
            workspaceSnapshots: [],
          },
        }) satisfies PrimeAgentProviderState,
    );
  });

  const snapshotForCwd = Effect.fn("PrimeAgentProvider.snapshotForCwd")(function* (cwd: string) {
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    return workspace
      ? { ...snapshot, slashCommands: workspace.slashCommands, skills: workspace.skills }
      : snapshot;
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
