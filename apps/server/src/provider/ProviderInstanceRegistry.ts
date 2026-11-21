import { builtinContextLayer } from "../plugins/PluginKernel.ts";
import {
  providerInstanceConfigEnabledFlag,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceEnvironment,
  type ProviderDriverKind,
  type ResolvedProviderInstanceEnvironment,
  type SecretReference,
  secretReferencesInSettings,
  type ServerProvider,
  type SettingsSecretSlot,
  withSettingsSecrets,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

import { buildUnavailableProviderSnapshot } from "./unavailableProviderSnapshot.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderDriverContributionEntry } from "./ProviderDriverCatalog.ts";
import { ProviderDriverError } from "./Errors.ts";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";

export class ProviderInstanceRegistry extends Context.Service<
  ProviderInstanceRegistry,
  {
    readonly getInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderInstance | undefined>;
    readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
    readonly listUnavailable: Effect.Effect<ReadonlyArray<ServerProvider>>;
    /** streamChanges subscribes on consumption; use subscribeChanges before forking to avoid missing the next publish. */
    readonly streamChanges: Stream.Stream<void>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/provider/ProviderInstanceRegistry") {}

interface InstanceSecrets {
  readonly environment: ResolvedProviderInstanceEnvironment;
  readonly config: ReadonlyArray<SettingsSecretSlot & { readonly value: string }>;
}

function validateProviderInstance(
  instance: ProviderInstance,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
) {
  if (
    !instance ||
    instance.instanceId !== instanceId ||
    instance.driverKind !== driver ||
    typeof instance.enabled !== "boolean" ||
    instance.continuationIdentity?.driverKind !== driver ||
    typeof instance.continuationIdentity.continuationKey !== "string" ||
    !Effect.isEffect(instance.snapshot?.getSnapshot) ||
    !Effect.isEffect(instance.snapshot.refresh) ||
    !Stream.isStream(instance.snapshot.streamChanges) ||
    typeof instance.snapshot.resolveMaintenance !== "function" ||
    typeof instance.snapshot.applyUsageLimits !== "function" ||
    instance.orchestrationAdapter?.instanceId !== instanceId ||
    instance.orchestrationAdapter.driver !== driver ||
    typeof instance.orchestrationAdapter.getCapabilities !== "function" ||
    typeof instance.orchestrationAdapter.planSelectionTransition !== "function" ||
    typeof instance.orchestrationAdapter.openSession !== "function" ||
    typeof instance.textGeneration?.generateTranscriptionPostProcessing !== "function" ||
    typeof instance.textGeneration.generateCommitMessage !== "function" ||
    typeof instance.textGeneration.generatePrContent !== "function" ||
    typeof instance.textGeneration.generateBranchName !== "function" ||
    typeof instance.textGeneration.generateThreadTitle !== "function" ||
    typeof instance.textGeneration.generateReviewGuide !== "function"
  )
    throw new Error("Provider factory returned an invalid instance.");
}

interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
  readonly secrets: InstanceSecrets;
  readonly driverRevision: number;
  readonly activity: {
    sessions: number;
    operations: number;
    accepting: boolean;
    closed: boolean;
    readonly lock: Semaphore.Semaphore;
  };
}

interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  // Configs parked on an unreadable secret. A settings save that leaves one alone does not read
  // its vault again, so a locked vault is not prompted for on every unrelated save.
  readonly secretsUnreadable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ProviderInstanceConfig>>;
  readonly changes: PubSub.PubSub<void>;
}

const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

const secretReferencesIn = (environment: ProviderInstanceEnvironment): Array<SecretReference> =>
  environment.flatMap((variable) => (typeof variable.value === "string" ? [] : [variable.value]));

const configSecretReferences = <R>(
  driver: AnyProviderDriver<R> | undefined,
  entry: ProviderInstanceConfig,
) => (driver === undefined ? [] : secretReferencesInSettings(driver.configSchema, entry.config));

const secretReferencesOf = <R>(
  driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>,
  entry: ProviderInstanceConfig,
): ReadonlyArray<SecretReference> => [
  ...secretReferencesIn(entry.environment ?? []),
  ...configSecretReferences(driversById.get(entry.driver), entry).map(({ reference }) => reference),
];

const withoutSecretReferences = (
  environment: ProviderInstanceEnvironment,
): ResolvedProviderInstanceEnvironment =>
  environment.flatMap((variable) =>
    typeof variable.value === "string" ? [{ ...variable, value: variable.value }] : [],
  );

interface CheckedSecret {
  readonly reference: SecretReference;
  readonly value: string;
}

const sameReference = (a: SecretReference, b: SecretReference) =>
  a.provider === b.provider && a.reference === b.reference;

// `checked` supplies its reference's value instead of the resolver, which a concurrent refresh
// may have re-read since the check.
const readInstanceSecrets = Effect.fn("ProviderInstanceRegistry.readInstanceSecrets")(function* <R>(
  driver: AnyProviderDriver<R> | undefined,
  entry: ProviderInstanceConfig,
  checked?: CheckedSecret,
) {
  const variables = entry.environment ?? [];
  const configFields = configSecretReferences(driver, entry);
  const references = [
    ...secretReferencesIn(variables),
    ...configFields.map(({ reference }) => reference),
  ];
  const isChecked = (reference: SecretReference) =>
    checked !== undefined && sameReference(reference, checked.reference);
  const toRead = references.filter((reference) => !isChecked(reference));
  const read =
    toRead.length === 0 ? [] : yield* (yield* SecretResolver.SecretResolver).read(toRead);
  let readIndex = 0;
  const values = references.map((reference) =>
    isChecked(reference) ? checked?.value : read[readIndex++],
  );
  const unreadable: Array<string> = [];
  let index = 0;
  // An empty secret reads as unreadable, so a driver cannot fall back to an inherited credential.
  const next = () => {
    const secret = values[index++];
    return secret === undefined || secret.trim() === "" ? undefined : secret;
  };
  const environment: ResolvedProviderInstanceEnvironment = variables.flatMap((variable) => {
    if (typeof variable.value === "string") return [{ ...variable, value: variable.value }];
    const secret = next();
    if (secret === undefined) {
      unreadable.push(variable.name);
      return [];
    }
    return [{ ...variable, value: secret, sensitive: true }];
  });
  const config = configFields.flatMap(({ field, key }) => {
    const secret = next();
    if (secret !== undefined) return [{ field, key, value: secret }];
    unreadable.push(field);
    return [];
  });
  const secrets: InstanceSecrets = { environment, config };
  return { secrets, unreadable };
});

// Replaces only the checked reference's value in the secrets a live instance already holds, so
// another reference whose read failed earlier is not read again and does not park the instance.
const carryCheckedSecret = <R>(
  driver: AnyProviderDriver<R> | undefined,
  entry: ProviderInstanceConfig,
  current: InstanceSecrets,
  { reference: checked, value }: CheckedSecret,
): InstanceSecrets => {
  const matches = (reference: SecretReference) => sameReference(reference, checked);
  // A live instance resolved every variable in order, so slots line up with the entry's variables
  // by position; names may repeat.
  const variables = entry.environment ?? [];
  const replacedSlots = configSecretReferences(driver, entry).filter(({ reference }) =>
    matches(reference),
  );
  return {
    environment: current.environment.map((variable, index) => {
      const source = variables[index]?.value;
      return source !== undefined && typeof source !== "string" && matches(source)
        ? { ...variable, value }
        : variable;
    }),
    config: current.config.map((slot) =>
      replacedSlots.some(({ field, key }) => field === slot.field && key === slot.key)
        ? { ...slot, value }
        : slot,
    ),
  };
};

/** Conflicting saved flags must preserve any explicit disable. */
const resolveEntryEnabled = (entry: ProviderInstanceConfig, typedConfig: unknown): boolean => {
  const rawConfigEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || rawConfigEnabled === false) {
    return false;
  }
  return entry.enabled ?? providerInstanceConfigEnabledFlag(typedConfig) ?? true;
};

type BlockedReason = (driver: ProviderDriverKind) => string | undefined;

// The enabled state `buildEntry` decodes, so a disabled instance never reads its secrets.
const isEntryEnabled = Effect.fn("ProviderInstanceRegistry.isEntryEnabled")(function* <R>(
  driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>,
  entry: ProviderInstanceConfig,
) {
  const driver = driversById.get(entry.driver);
  if (!driver) return false;
  const decoder = Schema.decodeUnknownEffect(driver.configSchema);
  const decoded = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.option);
  return Option.isSome(decoded) && resolveEntryEnabled(entry, decoded.value);
});

const buildEntry = Effect.fn("ProviderInstanceRegistry.buildEntry")(function* <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly contributionsById: ReadonlyMap<ProviderDriverKind, ProviderDriverContributionEntry<R>>;
  readonly blockedReason: BlockedReason;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
  readonly deferSecrets: boolean;
  readonly carriedSecrets?: InstanceSecrets | undefined;
  readonly onSessionsDrained: () => Effect.Effect<void>;
}): Effect.fn.Return<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | {
      readonly kind: "unavailable";
      readonly snapshot: ServerProvider;
      readonly secretsUnreadable?: true;
    },
  never,
  R | SecretResolver.SecretResolver
> {
  const {
    driversById,
    parentScope,
    instanceId,
    rawInstanceId,
    entry,
    deferSecrets,
    carriedSecrets,
  } = input;
  const blocked = input.blockedReason(entry.driver);
  if (blocked !== undefined) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: blocked,
      }),
    };
  }
  const contribution = input.contributionsById.get(entry.driver);
  if (!contribution) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Driver '${entry.driver}' is not registered in this build.`,
      }),
    };
  }
  const driver = contribution.driver;

  const decoder = Schema.decodeUnknownEffect(driver.configSchema);
  const decodeResult = yield* Effect.suspend(() =>
    decoder(entry.config ?? driver.defaultConfig()),
  ).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        new ProviderDriverError({
          driver: entry.driver,
          instanceId,
          detail: "Provider config decoder threw an unexpected error.",
          cause,
        }),
      ),
    ),
    Effect.result,
  );
  if (decodeResult._tag === "Failure") {
    const issue = decodeResult.failure;
    const detail = issue.message ?? String(issue);
    yield* Effect.logError("Failed to decode provider instance config", {
      instanceId: rawInstanceId,
      driver: entry.driver,
      detail,
    });
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
      }),
    };
  }

  const typedConfig = decodeResult.success;
  const enabled = resolveEntryEnabled(entry, typedConfig);
  if (deferSecrets && enabled && secretReferencesOf(driversById, entry).length > 0) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: "Reading secrets…",
      }),
    };
  }
  const { secrets, unreadable } = carriedSecrets
    ? { secrets: carriedSecrets, unreadable: [] }
    : enabled
      ? yield* readInstanceSecrets(driver, entry)
      : {
          secrets: { environment: withoutSecretReferences(entry.environment ?? []), config: [] },
          unreadable: [],
        };
  // Starting with a blank credential would fail later with a less useful error, or fall back to
  // whatever the server inherited.
  if (unreadable.length > 0) {
    return {
      kind: "unavailable" as const,
      secretsUnreadable: true as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Could not read ${unreadable.join(", ")} from its secret provider. Unlock it, then refresh.`,
      }),
    };
  }

  const childScope = yield* Scope.fork(parentScope);
  if (contribution.retain) {
    const retained = yield* contribution.retain.pipe(
      Effect.catchDefect((cause) =>
        Effect.fail(
          new ProviderDriverError({
            driver: entry.driver,
            instanceId,
            detail: "Provider plugin generation is no longer available.",
            cause,
          }),
        ),
      ),
      Effect.result,
    );
    if (retained._tag === "Failure") {
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: retained.failure.detail,
        }),
      };
    }
    yield* Scope.addFinalizer(childScope, retained.success);
  }

  const createResult = yield* Effect.suspend(() =>
    driver.create({
      instanceId,
      displayName: entry.displayName,
      accentColor: entry.accentColor,
      environment: secrets.environment,
      enabled,
      config:
        secrets.config.length === 0
          ? typedConfig
          : withSettingsSecrets(typedConfig, secrets.config),
    }),
  ).pipe(
    Effect.tap((instance) =>
      Effect.sync(() => validateProviderInstance(instance, instanceId, entry.driver)),
    ),
    Effect.provideService(Scope.Scope, childScope),
    Effect.catchDefect((cause) =>
      Effect.fail(
        new ProviderDriverError({
          driver: entry.driver,
          instanceId,
          detail: "Provider factory threw an unexpected error.",
          cause,
        }),
      ),
    ),
    Effect.result,
  );
  if (createResult._tag === "Failure") {
    yield* Effect.logError("Failed to create provider instance", {
      instanceId: rawInstanceId,
      driver: entry.driver,
      detail: createResult.failure.detail,
    });
    yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Driver '${entry.driver}' failed to create instance: ${createResult.failure.detail}`,
      }),
    };
  }

  const activity = {
    sessions: 0,
    operations: 0,
    accepting: true,
    closed: false,
    lock: yield* Semaphore.make(1),
  };
  yield* Scope.addFinalizer(
    childScope,
    Effect.sync(() => {
      activity.closed = true;
    }),
  );
  const retainOperation = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      activity.lock.withPermits(1)(
        Effect.suspend(() => {
          if (activity.closed) return Effect.interrupt;
          activity.operations += 1;
          return Effect.void;
        }),
      ),
      () => operation,
      () =>
        activity.lock
          .withPermits(1)(
            Effect.sync(() => {
              activity.operations -= 1;
              return !activity.accepting && activity.sessions === 0 && activity.operations === 0;
            }),
          )
          .pipe(Effect.flatMap((drained) => (drained ? input.onSessionsDrained() : Effect.void))),
    );
  // Finite provider calls share their factory scope with sessions. Change streams
  // remain scope-owned subscriptions and must not pin a replacement indefinitely.
  const retainMethod =
    <Args extends ReadonlyArray<unknown>, A, E, R>(
      method: (...args: Args) => Effect.Effect<A, E, R>,
    ) =>
    (...args: Args) =>
      retainOperation(Effect.suspend(() => method(...args)));
  const original = createResult.success;
  const auth = original.auth;
  const acp = original.acpSessionManagement;
  const instance: ProviderInstance = {
    ...original,
    snapshot: {
      ...original.snapshot,
      getSnapshot: retainOperation(original.snapshot.getSnapshot),
      refresh: retainOperation(original.snapshot.refresh),
      resolveMaintenance: retainMethod(
        original.snapshot.resolveMaintenance.bind(original.snapshot),
      ),
      applyUsageLimits: retainMethod(original.snapshot.applyUsageLimits.bind(original.snapshot)),
      ...(original.snapshot.refreshUsage
        ? { refreshUsage: retainOperation(original.snapshot.refreshUsage) }
        : {}),
    },
    textGeneration: {
      generateTranscriptionPostProcessing: retainMethod(
        original.textGeneration.generateTranscriptionPostProcessing.bind(original.textGeneration),
      ),
      generateCommitMessage: retainMethod(
        original.textGeneration.generateCommitMessage.bind(original.textGeneration),
      ),
      generatePrContent: retainMethod(
        original.textGeneration.generatePrContent.bind(original.textGeneration),
      ),
      generateBranchName: retainMethod(
        original.textGeneration.generateBranchName.bind(original.textGeneration),
      ),
      generateThreadTitle: retainMethod(
        original.textGeneration.generateThreadTitle.bind(original.textGeneration),
      ),
      generateReviewGuide: retainMethod(
        original.textGeneration.generateReviewGuide.bind(original.textGeneration),
      ),
    },
    ...(original.snapshotForCwd
      ? { snapshotForCwd: retainMethod(original.snapshotForCwd.bind(original)) }
      : {}),
    ...(original.refreshModels
      ? { refreshModels: retainMethod(original.refreshModels.bind(original)) }
      : {}),
    ...(original.invalidateCaches
      ? { invalidateCaches: retainOperation(original.invalidateCaches) }
      : {}),
    ...(original.afterUpdate ? { afterUpdate: retainOperation(original.afterUpdate) } : {}),
    ...(original.consumeResetCredit
      ? { consumeResetCredit: retainMethod(original.consumeResetCredit.bind(original)) }
      : {}),
    ...(auth
      ? {
          auth: {
            ...auth,
            start: retainMethod(auth.start.bind(auth)),
            complete: retainMethod(auth.complete.bind(auth)),
            cancel: retainMethod(auth.cancel.bind(auth)),
            logout: retainMethod(auth.logout.bind(auth)),
            ...(auth.reconnectProfile
              ? { reconnectProfile: retainMethod(auth.reconnectProfile.bind(auth)) }
              : {}),
            ...(auth.importProfile
              ? { importProfile: retainMethod(auth.importProfile.bind(auth)) }
              : {}),
            ...(auth.adoptCredentials
              ? { adoptCredentials: retainMethod(auth.adoptCredentials.bind(auth)) }
              : {}),
            ...(auth.respond ? { respond: retainMethod(auth.respond.bind(auth)) } : {}),
            ...(auth.removeMethod
              ? { removeMethod: retainMethod(auth.removeMethod.bind(auth)) }
              : {}),
            ...(auth.isChangingCredentials
              ? { isChangingCredentials: retainOperation(auth.isChangingCredentials) }
              : {}),
            ...(auth.invalidate ? { invalidate: retainOperation(auth.invalidate) } : {}),
            ...(auth.refreshMethods
              ? { refreshMethods: retainOperation(auth.refreshMethods) }
              : {}),
            ...(auth.withAccess
              ? {
                  withAccess: <A, E, R>(task: Effect.Effect<A, E, R>) =>
                    retainOperation(auth.withAccess!(task)),
                }
              : {}),
          },
        }
      : {}),
    ...(acp
      ? {
          acpSessionManagement: {
            listSessions: retainMethod(acp.listSessions.bind(acp)),
            logout: retainMethod(acp.logout.bind(acp)),
            deleteSession: retainMethod(acp.deleteSession.bind(acp)),
            listProviders: retainMethod(acp.listProviders.bind(acp)),
            setProvider: retainMethod(acp.setProvider.bind(acp)),
            disableProvider: retainMethod(acp.disableProvider.bind(acp)),
          },
        }
      : {}),
    orchestrationAdapter: {
      ...original.orchestrationAdapter,
      getCapabilities: retainMethod(
        original.orchestrationAdapter.getCapabilities.bind(original.orchestrationAdapter),
      ),
      planSelectionTransition: retainMethod(
        original.orchestrationAdapter.planSelectionTransition.bind(original.orchestrationAdapter),
      ),
      openSession: Effect.fn("ProviderInstanceRegistry.openSession")(function* (
        sessionInput: ProviderAdapterV2OpenSessionInput,
      ) {
        const release = (lease: { released: boolean }) =>
          activity.lock
            .withPermits(1)(
              Effect.sync(() => {
                if (lease.released) return false;
                lease.released = true;
                activity.sessions -= 1;
                return activity.sessions === 0 && activity.operations === 0;
              }),
            )
            .pipe(Effect.flatMap((drained) => (drained ? input.onSessionsDrained() : Effect.void)));
        const lease = yield* Effect.acquireRelease(
          activity.lock.withPermits(1)(
            Effect.gen(function* () {
              if (!activity.accepting) {
                return yield* new ProviderAdapterOpenSessionError({
                  driver: original.driverKind,
                  providerSessionId: sessionInput.providerSessionId,
                  cause: "Provider configuration changed. Retry after its active sessions finish.",
                });
              }
              activity.sessions += 1;
              return { released: false };
            }),
          ),
          release,
        );
        const runtime = yield* original.orchestrationAdapter
          .openSession(sessionInput)
          .pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? release(lease) : Effect.void)));
        const admitTurn = (turnInput: ProviderAdapterV2TurnInput) =>
          Effect.suspend(() =>
            activity.accepting
              ? Effect.void
              : Effect.fail(
                  new ProviderAdapterTurnStartError({
                    driver: original.driverKind,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause:
                      "Provider plugin changed or was disabled. Reconnect after its active sessions finish.",
                  }),
                ),
          );
        return {
          ...runtime,
          acceptingTurns: Effect.sync(() => activity.accepting),
          startTurn: (turnInput) =>
            admitTurn(turnInput).pipe(Effect.andThen(() => runtime.startTurn(turnInput))),
          ...(runtime.compactThread
            ? {
                compactThread: (turnInput: ProviderAdapterV2TurnInput) =>
                  admitTurn(turnInput).pipe(
                    Effect.andThen(() => runtime.compactThread!(turnInput)),
                  ),
              }
            : {}),
        };
      }),
    },
  };
  return {
    kind: "live" as const,
    live: {
      instance,
      scope: childScope,
      entry,
      secrets,
      driverRevision: contribution.revision,
      activity,
    },
  };
});

const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly drivers: Effect.Effect<readonly ProviderDriverContributionEntry<R>[]>;
  readonly blockedReason: BlockedReason;
  readonly parentScope: Scope.Scope;
  readonly onSessionsDrained: () => Effect.Effect<void>;
}): ((
  configMap: ProviderInstanceConfigMap,
  rebuild?: ReadonlySet<ProviderInstanceId>,
  deferSecrets?: boolean,
  carried?: ReadonlyMap<ProviderInstanceId, InstanceSecrets>,
) => Effect.Effect<void, never, R | SecretResolver.SecretResolver>) => {
  const { state, blockedReason, parentScope, onSessionsDrained } = input;
  // Rebuilds requested while an instance was pinned by active sessions wait for its drain.
  const pendingRebuild = new Set<ProviderInstanceId>();
  const pendingCarried = new Map<ProviderInstanceId, InstanceSecrets>();
  return (
    configMap,
    requestedRebuild = new Set(),
    deferSecrets = false,
    requestedCarried = new Map(),
  ) =>
    Effect.gen(function* () {
      const contributionsById = new Map(
        (yield* input.drivers).map((entry) => [entry.driver.driverKind, entry]),
      );
      const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
        [...contributionsById].map(([driverKind, entry]) => [driverKind, entry.driver]),
      );
      const rebuild = new Set([...pendingRebuild, ...requestedRebuild]);
      const carried = new Map([...pendingCarried, ...requestedCarried]);
      pendingRebuild.clear();
      pendingCarried.clear();
      const previousEntries = yield* Ref.get(state.entries);
      const previousUnavailable = yield* Ref.get(state.unavailable);
      const previousSecretsUnreadable = yield* Ref.get(state.secretsUnreadable);
      const nextRaw = Object.entries(configMap);
      const nextKeys = new Set<ProviderInstanceId>(
        nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
      );

      // Active session scopes pin their factory generation. Stop admitting new
      // sessions on stale instances, then apply the latest change when they drain.
      const removedIds: Array<ProviderInstanceId> = [];
      const replacedIds = new Set<ProviderInstanceId>();
      const pinnedRemoved = new Map<ProviderInstanceId, LiveEntry>();
      let admissionChanged = false;
      for (const [instanceId, live] of previousEntries) {
        const nextEntry = configMap[instanceId];
        const changed =
          nextEntry === undefined ||
          rebuild.has(instanceId) ||
          !entryEqual(live.entry, nextEntry) ||
          live.driverRevision !== contributionsById.get(nextEntry.driver)?.revision;
        if (!changed) {
          if (!live.activity.accepting) admissionChanged = true;
          live.activity.accepting = true;
          continue;
        }
        // Closing under the lock stops new sessions and operations before the scope closes.
        const closed = yield* live.activity.lock.withPermits(1)(
          Effect.sync(() => {
            if (live.activity.accepting) admissionChanged = true;
            live.activity.accepting = false;
            if (live.activity.sessions > 0 || live.activity.operations > 0) return false;
            live.activity.closed = true;
            return true;
          }),
        );
        if (closed && nextKeys.has(instanceId)) replacedIds.add(instanceId);
        else if (closed) removedIds.push(instanceId);
        else if (!nextKeys.has(instanceId)) pinnedRemoved.set(instanceId, live);
        else if (rebuild.has(instanceId)) {
          pendingRebuild.add(instanceId);
          const secrets = carried.get(instanceId);
          if (secrets !== undefined) pendingCarried.set(instanceId, secrets);
        }
      }
      const retiredIds = [...removedIds, ...replacedIds];
      if (retiredIds.length > 0) {
        const remaining = new Map(previousEntries);
        for (const id of retiredIds) remaining.delete(id);
        yield* Ref.set(state.entries, remaining);
      }
      for (const id of retiredIds) {
        const live = previousEntries.get(id);
        if (live) {
          yield* Scope.close(live.scope, Exit.void).pipe(Effect.ignore);
        }
      }

      const parkedSnapshot = (instanceId: ProviderInstanceId, entry: ProviderInstanceConfig) => {
        const parked = previousSecretsUnreadable.get(instanceId);
        return !rebuild.has(instanceId) && parked !== undefined && entryEqual(parked, entry)
          ? previousUnavailable.get(instanceId)
          : undefined;
      };

      // Read every secret the builds below need in one go, so a vault unlocks once.
      const references = yield* Effect.forEach(nextRaw, ([rawInstanceId, entry]) =>
        Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make(rawInstanceId);
          const kept = previousEntries.has(instanceId) && !replacedIds.has(instanceId);
          return kept ||
            carried.has(instanceId) ||
            parkedSnapshot(instanceId, entry) !== undefined ||
            !(yield* isEntryEnabled(driversById, entry))
            ? []
            : secretReferencesOf(driversById, entry);
        }),
      ).pipe(Effect.map((perEntry) => perEntry.flat()));
      if (references.length > 0 && !deferSecrets) {
        yield* (yield* SecretResolver.SecretResolver).read(references);
      }

      const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
      const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
      const builtSecretsUnreadable = new Map<ProviderInstanceId, ProviderInstanceConfig>();
      let orderChanged = false;
      const previousOrder = [...previousEntries.keys()];
      const nextOrder: Array<ProviderInstanceId> = [];

      for (const [rawInstanceId, entry] of nextRaw) {
        const instanceId = ProviderInstanceId.make(rawInstanceId);
        nextOrder.push(instanceId);

        const existing = previousEntries.get(instanceId);
        if (existing !== undefined && !replacedIds.has(instanceId)) {
          builtEntries.set(instanceId, existing);
          continue;
        }
        const parked = parkedSnapshot(instanceId, entry);
        if (parked !== undefined) {
          builtUnavailable.set(instanceId, parked);
          builtSecretsUnreadable.set(instanceId, entry);
          continue;
        }

        const result = yield* buildEntry({
          driversById,
          contributionsById,
          blockedReason,
          parentScope,
          instanceId,
          rawInstanceId,
          entry,
          deferSecrets,
          carriedSecrets: carried.get(instanceId),
          onSessionsDrained,
        });
        if (result.kind === "live") {
          builtEntries.set(instanceId, result.live);
        } else {
          builtUnavailable.set(instanceId, result.snapshot);
          if (result.secretsUnreadable) builtSecretsUnreadable.set(instanceId, entry);
        }
      }
      for (const [instanceId, live] of pinnedRemoved) {
        builtEntries.set(instanceId, live);
        nextOrder.push(instanceId);
      }

      if (previousOrder.length === nextOrder.length) {
        for (let i = 0; i < previousOrder.length; i++) {
          if (previousOrder[i] !== nextOrder[i]) {
            orderChanged = true;
            break;
          }
        }
      } else {
        orderChanged = true;
      }

      const entriesChanged =
        admissionChanged ||
        orderChanged ||
        removedIds.length > 0 ||
        replacedIds.size > 0 ||
        builtEntries.size !== previousEntries.size;
      const unavailableChanged =
        builtUnavailable.size !== previousUnavailable.size ||
        [...builtUnavailable].some(([id, snapshot]) => {
          const prev = previousUnavailable.get(id);
          return prev === undefined || !Equal.equals(prev, snapshot);
        }) ||
        [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

      yield* Ref.set(state.entries, builtEntries);
      yield* Ref.set(state.unavailable, builtUnavailable);
      yield* Ref.set(state.secretsUnreadable, builtSecretsUnreadable);

      if (entriesChanged || unavailableChanged) {
        yield* PubSub.publish(state.changes, undefined);
      }
    });
};

export const makeProviderInstanceRegistry = Effect.fn(
  "ProviderInstanceRegistry.makeProviderInstanceRegistry",
)(function* <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  /** A reason to show instead of running a driver, such as an administrator's policy. */
  readonly blockedReason?: BlockedReason | undefined;
  readonly driverCatalog?: {
    readonly list: Effect.Effect<readonly ProviderDriverContributionEntry<R>[]>;
  };
}): Effect.fn.Return<
  {
    readonly registry: ProviderInstanceRegistry["Service"];
    readonly mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | SecretResolver.SecretResolver | Scope.Scope
> {
  const drivers: Effect.Effect<readonly ProviderDriverContributionEntry<R>[]> =
    input.driverCatalog?.list ??
    Effect.succeed(input.drivers.map((driver) => ({ driver, revision: 0, pluginId: "static" })));
  const currentDriversById = drivers.pipe(
    Effect.map(
      (entries) =>
        new Map<ProviderDriverKind, AnyProviderDriver<R>>(
          entries.map((entry) => [entry.driver.driverKind, entry.driver]),
        ),
    ),
  );

  // Capture the enclosing scope so per-instance child scopes can be
  // attached to it at `reconcile` time. Without this, `reconcile`
  // called later (e.g. from the hydration layer) would attach child
  // scopes to the *caller's* scope instead of the registry's.
  const registryScope = yield* Scope.Scope;
  const parentScope = yield* Scope.fork(registryScope);

  const driverContext = yield* Effect.context<R | SecretResolver.SecretResolver>();

  const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
  const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
  const secretsUnreadable = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ProviderInstanceConfig>
  >(new Map());
  const changes = yield* PubSub.unbounded<void>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const state: RegistryState = { entries, unavailable, secretsUnreadable, changes };
  const configMapRef = yield* Ref.make(input.configMap);
  const semaphore = yield* Semaphore.make(1);
  let closing = false;
  const reconcileWithR = makeReconcile({
    state,
    drivers,
    blockedReason: input.blockedReason ?? (() => undefined),
    parentScope,
    onSessionsDrained: () => applyLatest(),
  });
  const applyLatest = (configMap?: ProviderInstanceConfigMap): Effect.Effect<void> =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        if (closing) return;
        if (configMap !== undefined) yield* Ref.set(configMapRef, configMap);
        yield* reconcileWithR(yield* Ref.get(configMapRef));
      }).pipe(Effect.provideContext(driverContext)),
    );
  const reconcile: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["reconcile"] =
    applyLatest;

  // Rebuilds an instance only when it was unavailable or its secrets changed, so a refresh does
  // not restart providers whose credentials are the same. Without `checked` the cached values are
  // dropped first; with it, only that reference takes the checked value and the rest carry over.
  const reloadWhere = Effect.fn("ProviderInstanceRegistry.reloadWhere")(
    function* (
      select: (
        rawInstanceId: string,
        entry: ProviderInstanceConfig,
        driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>,
      ) => boolean,
      checked?: CheckedSecret,
    ) {
      const driversById = yield* currentDriversById;
      const configMap = yield* Ref.get(configMapRef);
      const targets = yield* Effect.filter(Object.entries(configMap), ([rawInstanceId, entry]) =>
        select(rawInstanceId, entry, driversById) &&
        secretReferencesOf(driversById, entry).length > 0
          ? isEntryEnabled(driversById, entry)
          : Effect.succeed(false),
      );
      if (targets.length === 0) return [];
      if (checked === undefined) {
        const resolver = yield* SecretResolver.SecretResolver;
        const references = targets.flatMap(([, entry]) => secretReferencesOf(driversById, entry));
        yield* resolver.invalidate(references);
        yield* resolver.read(references);
      }
      const live = yield* Ref.get(entries);
      const rebuild = new Set<ProviderInstanceId>();
      const carried = new Map<ProviderInstanceId, InstanceSecrets>();
      for (const [rawInstanceId, entry] of targets) {
        const instanceId = ProviderInstanceId.make(rawInstanceId);
        const current = live.get(instanceId);
        if (current === undefined) {
          rebuild.add(instanceId);
          if (checked !== undefined) {
            const { secrets, unreadable } = yield* readInstanceSecrets(
              driversById.get(entry.driver),
              entry,
              checked,
            );
            if (unreadable.length === 0) carried.set(instanceId, secrets);
          }
          continue;
        }
        if (checked !== undefined) {
          const secrets = carryCheckedSecret(
            driversById.get(entry.driver),
            current.entry,
            current.secrets,
            checked,
          );
          if (!Equal.equals(secrets, current.secrets)) {
            rebuild.add(current.instance.instanceId);
            carried.set(current.instance.instanceId, secrets);
          }
          continue;
        }
        const { secrets, unreadable } = yield* readInstanceSecrets(
          driversById.get(entry.driver),
          entry,
        );
        // A failed re-read keeps the working instance and the value it already holds.
        if (unreadable.length === 0 && !Equal.equals(secrets, current.secrets)) {
          rebuild.add(current.instance.instanceId);
        }
      }
      yield* reconcileWithR(configMap, rebuild, false, carried);
      return targets.map(([rawInstanceId]) => ProviderInstanceId.make(rawInstanceId));
    },
    (effect) => semaphore.withPermits(1)(effect),
    Effect.provideContext(driverContext),
  );
  const reloadSecrets: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["reloadSecrets"] =
    (instanceId) =>
      reloadWhere(
        (rawInstanceId) => instanceId === undefined || rawInstanceId === instanceId,
        undefined,
      ).pipe(Effect.asVoid);
  const rebuild: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["rebuild"] = (
    instanceIds,
  ) =>
    semaphore.withPermits(1)(
      Ref.get(configMapRef).pipe(
        Effect.flatMap((configMap) => reconcileWithR(configMap, new Set(instanceIds))),
        Effect.provideContext(driverContext),
      ),
    );
  const applySecret: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["applySecret"] =
    (reference, value) =>
      reloadWhere(
        (_, entry, driversById) =>
          secretReferencesOf(driversById, entry).some((candidate) =>
            sameReference(candidate, reference),
          ),
        { reference, value },
      );

  // Reading secrets can wait on a vault unlock, so the server does not wait for it to start.
  yield* semaphore.withPermits(1)(
    Ref.set(configMapRef, input.configMap).pipe(
      Effect.andThen(reconcileWithR(input.configMap, new Set(), true)),
      Effect.provideContext(driverContext),
    ),
  );
  // Dynamic child scopes live under parentScope, so this root finalizer always
  // disables drain reconciliation before shutdown closes any provider instance.
  yield* Scope.addFinalizer(
    registryScope,
    Effect.sync(() => {
      closing = true;
    }),
  );
  const startupDriversById = yield* currentDriversById;
  const startupReferences = yield* Effect.filter(Object.entries(input.configMap), ([, entry]) =>
    secretReferencesOf(startupDriversById, entry).length > 0
      ? isEntryEnabled(startupDriversById, entry)
      : Effect.succeed(false),
  ).pipe(
    Effect.map((targets) =>
      targets.flatMap(([, entry]) => secretReferencesOf(startupDriversById, entry)),
    ),
  );
  if (startupReferences.length > 0) {
    // The read waits outside the lock so other mutations are not held for a vault prompt; a
    // configuration saved meanwhile has already reconciled itself.
    yield* Effect.gen(function* () {
      yield* (yield* SecretResolver.SecretResolver).read(startupReferences);
      yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(configMapRef);
          if (!closing && current === input.configMap) yield* reconcileWithR(current);
        }),
      );
    }).pipe(Effect.provideContext(driverContext), Effect.forkScoped);
  }

  const registry: ProviderInstanceRegistry["Service"] = {
    getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
    listInstances: Ref.get(entries).pipe(
      Effect.map(
        (map) =>
          Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
      ),
    ),
    listUnavailable: Ref.get(unavailable).pipe(
      Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
    ),
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
    get subscribeChanges() {
      return PubSub.subscribe(changes);
    },
  };

  const mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape = {
    reconcile,
    reloadSecrets,
    rebuild,
    applySecret,
  };

  return { registry, mutator };
});

export const layer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  readonly blockedReason?: BlockedReason | undefined;
  readonly driverCatalog?: {
    readonly list: Effect.Effect<readonly ProviderDriverContributionEntry<R>[]>;
  };
}): Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  R | SecretResolver.SecretResolver
> =>
  builtinContextLayer(
    "t3.server",
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<
    ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
    never,
    R | SecretResolver.SecretResolver
  >;
