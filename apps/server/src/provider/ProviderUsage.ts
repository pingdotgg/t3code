import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageWindow,
  TrimmedNonEmptyString,
  type OrchestratorMcpProviderUsage,
  type OrchestratorMcpProviderUsageInput,
  type OrchestratorMcpProviderUsageResult,
  type ServerProvider,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/**
 * The provider status cache cannot serve this: cached snapshots hydrate
 * without usage, and the first boot write replaces the file. This store keeps
 * the last observed windows per instance until a newer observation lands.
 */
const StoredUsage = Schema.Record(
  ProviderInstanceId,
  Schema.Struct({
    driver: ProviderDriverKind,
    checkedAt: IsoDateTime,
    windows: Schema.Array(ServerProviderUsageWindow),
    email: Schema.optional(TrimmedNonEmptyString),
    workspaceId: Schema.optional(TrimmedNonEmptyString),
  }),
);
type StoredUsage = typeof StoredUsage.Type;
type StoredObservation = StoredUsage[ProviderInstanceId];
const decodeStoredUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredUsage));

export class ProviderUsage extends Context.Service<
  ProviderUsage,
  {
    /** One entry per enabled provider instance, in registry order. */
    readonly read: (
      input: OrchestratorMcpProviderUsageInput,
    ) => Effect.Effect<OrchestratorMcpProviderUsageResult>;
  }
>()("t3/provider/ProviderUsage") {}

const observedLimits = (provider: ServerProvider) =>
  provider.usageLimits !== undefined && provider.usageLimits.windows.length > 0
    ? provider.usageLimits
    : undefined;

const toWindows = (windows: ReadonlyArray<ServerProviderUsageWindow>) =>
  windows.map((window) => ({
    id: window.id,
    kind: window.kind,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ?? null,
    scope: window.model === undefined ? "account" : `model:${window.model}`,
  }));

// The same account-switch rule ManagedServerProvider applies to probe results.
const isSameAccount = (auth: ServerProvider["auth"], stored: StoredObservation) =>
  (auth.email === undefined ||
    stored.email === undefined ||
    auth.email.toLowerCase() === stored.email.toLowerCase()) &&
  (auth.workspaceId === undefined || auth.workspaceId === stored.workspaceId);

/**
 * Live snapshots only carry usage reported during this server session, so
 * they are `observed`. Anything else comes from the store and is `stale`.
 */
function describeProviderUsage(
  provider: ServerProvider,
  stored: StoredObservation | undefined,
): OrchestratorMcpProviderUsage {
  const identity = { providerInstanceId: provider.instanceId, driverKind: provider.driver };
  const live = observedLimits(provider);
  if (live) {
    return {
      ...identity,
      measuredAt: live.checkedAt,
      source: "observed",
      windows: toWindows(live.windows),
    };
  }
  // An account that can never report windows (API key, Bedrock) must not
  // keep showing a subscription it no longer uses.
  if (
    stored !== undefined &&
    stored.driver === provider.driver &&
    isSameAccount(provider.auth, stored) &&
    provider.usageLimits?.unavailable?.reason !== "unsupported"
  ) {
    return {
      ...identity,
      measuredAt: stored.checkedAt,
      source: "stale",
      windows: toWindows(stored.windows),
    };
  }
  return { ...identity, measuredAt: null, source: "none", windows: [] };
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.providerStatusCacheDir, "provider-usage.json");

  const initial = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeStoredUsage),
    Effect.orElseSucceed((): StoredUsage => ({})),
  );
  const storedRef = yield* Ref.make(initial);
  const writeStored = (stored: StoredUsage) =>
    writeFileStringAtomically({ filePath, contents: `${JSON.stringify(stored, null, 2)}\n` });

  // Driver usage events land in registry snapshots, so following its changes
  // records them without polling the provider.
  const persist = Effect.fn("ProviderUsage.persist")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    // Only this fiber writes the store. It advances after the write lands, so
    // a failed write is retried on the next change.
    const stored = yield* Ref.get(storedRef);
    let updated: StoredUsage | undefined;
    for (const provider of providers) {
      const live = observedLimits(provider);
      if (!live) {
        continue;
      }
      const { email, workspaceId } = provider.auth;
      const observation: StoredObservation = {
        driver: provider.driver,
        checkedAt: live.checkedAt,
        windows: live.windows,
        ...(email ? { email } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      };
      // `checkedAt` has millisecond resolution, so two updates can share it.
      if (!Equal.equals(stored[provider.instanceId], observation)) {
        updated = { ...(updated ?? stored), [provider.instanceId]: observation };
      }
    }
    if (updated) {
      yield* writeStored(updated).pipe(
        Effect.andThen(Ref.set(storedRef, updated)),
        Effect.tapError(Effect.logWarning),
        Effect.ignore,
      );
    }
  });

  yield* registry.streamChanges.pipe(Stream.runForEach(persist), Effect.forkScoped);

  const read = Effect.fn("ProviderUsage.read")(function* (
    input: OrchestratorMcpProviderUsageInput,
  ) {
    const providers = yield* registry.getProviders;
    const stored = yield* Ref.get(storedRef);
    return {
      providers: providers
        .filter(
          (provider) =>
            provider.enabled &&
            (input.providerInstanceId === undefined ||
              provider.instanceId === input.providerInstanceId),
        )
        .map((provider) => describeProviderUsage(provider, stored[provider.instanceId])),
    };
  });

  return ProviderUsage.of({ read });
});

export const layer = Layer.effect(ProviderUsage, make);
