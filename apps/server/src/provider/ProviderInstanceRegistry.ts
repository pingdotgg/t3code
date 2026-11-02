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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
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
  readonly config: Readonly<Record<string, string>>;
}

interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
  readonly secrets: InstanceSecrets;
}

interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
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

const readInstanceSecrets = Effect.fn("ProviderInstanceRegistry.readInstanceSecrets")(function* <R>(
  driver: AnyProviderDriver<R> | undefined,
  entry: ProviderInstanceConfig,
) {
  const variables = entry.environment ?? [];
  const configFields = configSecretReferences(driver, entry);
  const references = [
    ...secretReferencesIn(variables),
    ...configFields.map(({ reference }) => reference),
  ];
  const values =
    references.length === 0 ? [] : yield* (yield* SecretResolver.SecretResolver).read(references);
  const unreadable: Array<string> = [];
  let index = 0;
  const environment: ResolvedProviderInstanceEnvironment = variables.flatMap((variable) => {
    if (typeof variable.value === "string") return [{ ...variable, value: variable.value }];
    const secret = values[index++];
    if (secret === undefined) {
      unreadable.push(variable.name);
      return [];
    }
    return [{ ...variable, value: secret, sensitive: true }];
  });
  const config: Record<string, string> = {};
  for (const { field } of configFields) {
    const secret = values[index++];
    if (secret === undefined) unreadable.push(field);
    else config[field] = secret;
  }
  const secrets: InstanceSecrets = { environment, config };
  return { secrets, unreadable };
});

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
  readonly blockedReason: BlockedReason;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
  readonly deferSecrets: boolean;
}): Effect.fn.Return<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider },
  never,
  R | SecretResolver.SecretResolver
> {
  const { driversById, parentScope, instanceId, rawInstanceId, entry, deferSecrets } = input;
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
  const driver = driversById.get(entry.driver);
  if (!driver) {
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

  const decoder = Schema.decodeUnknownEffect(driver.configSchema);
  const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
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
  const { secrets, unreadable } = enabled
    ? yield* readInstanceSecrets(driver, entry)
    : {
        secrets: { environment: withoutSecretReferences(entry.environment ?? []), config: {} },
        unreadable: [],
      };
  // Starting with a blank credential would fail later with a less useful error, or fall back to
  // whatever the server inherited.
  if (unreadable.length > 0) {
    return {
      kind: "unavailable" as const,
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

  const createResult = yield* driver
    .create({
      instanceId,
      displayName: entry.displayName,
      accentColor: entry.accentColor,
      environment: secrets.environment,
      enabled,
      config:
        Object.keys(secrets.config).length === 0
          ? typedConfig
          : { ...typedConfig, ...secrets.config },
    })
    .pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
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

  return {
    kind: "live" as const,
    live: {
      instance: createResult.success,
      scope: childScope,
      entry,
      secrets,
    },
  };
});

const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly blockedReason: BlockedReason;
  readonly parentScope: Scope.Scope;
}): ((
  configMap: ProviderInstanceConfigMap,
  rebuild?: ReadonlySet<ProviderInstanceId>,
  deferSecrets?: boolean,
) => Effect.Effect<void, never, R | SecretResolver.SecretResolver>) => {
  const { state, driversById, blockedReason, parentScope } = input;
  return (configMap, rebuild = new Set(), deferSecrets = false) =>
    Effect.gen(function* () {
      const previousEntries = yield* Ref.get(state.entries);
      const previousUnavailable = yield* Ref.get(state.unavailable);
      const nextRaw = Object.entries(configMap);
      const nextKeys = new Set<ProviderInstanceId>(
        nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
      );

      // Close changed/removed scopes before replacements to preserve one live scope per id.
      const removedIds: Array<ProviderInstanceId> = [];
      const replacedIds = new Set<ProviderInstanceId>();
      for (const [instanceId, live] of previousEntries) {
        if (!nextKeys.has(instanceId)) {
          removedIds.push(instanceId);
          continue;
        }
        const nextEntry = configMap[instanceId];
        if (
          rebuild.has(instanceId) ||
          (nextEntry !== undefined && !entryEqual(live.entry, nextEntry))
        ) {
          replacedIds.add(instanceId);
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

      // Read every secret the builds below need in one go, so a vault unlocks once.
      const references = yield* Effect.forEach(nextRaw, ([rawInstanceId, entry]) =>
        Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make(rawInstanceId);
          const kept = previousEntries.has(instanceId) && !replacedIds.has(instanceId);
          return kept || !(yield* isEntryEnabled(driversById, entry))
            ? []
            : secretReferencesOf(driversById, entry);
        }),
      ).pipe(Effect.map((perEntry) => perEntry.flat()));
      if (references.length > 0 && !deferSecrets) {
        yield* (yield* SecretResolver.SecretResolver).read(references);
      }

      const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
      const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
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

        const result = yield* buildEntry({
          driversById,
          blockedReason,
          parentScope,
          instanceId,
          rawInstanceId,
          entry,
          deferSecrets,
        });
        if (result.kind === "live") {
          builtEntries.set(instanceId, result.live);
        } else {
          builtUnavailable.set(instanceId, result.snapshot);
        }
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
}): Effect.fn.Return<
  {
    readonly registry: ProviderInstanceRegistry["Service"];
    readonly mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | SecretResolver.SecretResolver | Scope.Scope
> {
  const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
    input.drivers.map((driver) => [driver.driverKind, driver]),
  );

  // Capture the enclosing scope so per-instance child scopes can be
  // attached to it at `reconcile` time. Without this, `reconcile`
  // called later (e.g. from the hydration layer) would attach child
  // scopes to the *caller's* scope instead of the registry's.
  const parentScope = yield* Scope.Scope;

  const driverContext = yield* Effect.context<R | SecretResolver.SecretResolver>();

  const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
  const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
  const changes = yield* PubSub.unbounded<void>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const state: RegistryState = { entries, unavailable, changes };
  const reconcileWithR = makeReconcile({
    state,
    driversById,
    blockedReason: input.blockedReason ?? (() => undefined),
    parentScope,
  });
  const configMapRef = yield* Ref.make(input.configMap);
  const semaphore = yield* Semaphore.make(1);
  const reconcile: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["reconcile"] =
    (configMap) =>
      semaphore.withPermits(1)(
        Ref.set(configMapRef, configMap).pipe(
          Effect.andThen(reconcileWithR(configMap)),
          Effect.provideContext(driverContext),
        ),
      );

  // Rebuilds an instance only when it was unavailable or its secrets changed, so a refresh does
  // not restart providers whose credentials are the same.
  const reloadSecrets: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["reloadSecrets"] =
    Effect.fn("ProviderInstanceRegistry.reloadSecrets")(
      function* (instanceId) {
        const configMap = yield* Ref.get(configMapRef);
        const targets = yield* Effect.filter(Object.entries(configMap), ([rawInstanceId, entry]) =>
          (instanceId === undefined || rawInstanceId === instanceId) &&
          secretReferencesOf(driversById, entry).length > 0
            ? isEntryEnabled(driversById, entry)
            : Effect.succeed(false),
        );
        if (targets.length === 0) return;
        const resolver = yield* SecretResolver.SecretResolver;
        const references = targets.flatMap(([, entry]) => secretReferencesOf(driversById, entry));
        yield* resolver.invalidate(references);
        yield* resolver.read(references);
        const live = yield* Ref.get(entries);
        const rebuild = new Set<ProviderInstanceId>();
        for (const [rawInstanceId, entry] of targets) {
          const current = live.get(ProviderInstanceId.make(rawInstanceId));
          if (current === undefined) continue;
          const { secrets, unreadable } = yield* readInstanceSecrets(
            driversById.get(entry.driver),
            entry,
          );
          // A failed re-read keeps the working instance and the value it already holds.
          if (unreadable.length === 0 && !Equal.equals(secrets, current.secrets)) {
            rebuild.add(current.instance.instanceId);
          }
        }
        yield* reconcileWithR(configMap, rebuild);
      },
      (effect) => semaphore.withPermits(1)(effect),
      Effect.provideContext(driverContext),
    );

  // Reading secrets can wait on a vault unlock, so the server does not wait for it to start.
  yield* semaphore.withPermits(1)(
    Ref.set(configMapRef, input.configMap).pipe(
      Effect.andThen(reconcileWithR(input.configMap, new Set(), true)),
      Effect.provideContext(driverContext),
    ),
  );
  const startupReferences = yield* Effect.filter(Object.entries(input.configMap), ([, entry]) =>
    secretReferencesOf(driversById, entry).length > 0
      ? isEntryEnabled(driversById, entry)
      : Effect.succeed(false),
  ).pipe(
    Effect.map((targets) => targets.flatMap(([, entry]) => secretReferencesOf(driversById, entry))),
  );
  if (startupReferences.length > 0) {
    // The read waits outside the lock so other mutations are not held for a vault prompt; a
    // configuration saved meanwhile has already reconciled itself.
    yield* Effect.gen(function* () {
      yield* (yield* SecretResolver.SecretResolver).read(startupReferences);
      yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(configMapRef);
          if (current === input.configMap) yield* reconcileWithR(current);
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
  };

  return { registry, mutator };
});

export const layer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  readonly blockedReason?: BlockedReason | undefined;
}): Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  R | SecretResolver.SecretResolver
> =>
  Layer.effectContext(
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
