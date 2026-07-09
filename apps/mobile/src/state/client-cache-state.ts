import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { type ClientCacheKind, MobileDatabase } from "../persistence/mobile-database";
import * as Runtime from "../lib/runtime";

export interface EnvironmentClientCacheSummary {
  readonly environmentId: EnvironmentId;
  readonly recordCount: number;
  readonly payloadBytes: number;
  readonly kinds: Readonly<Partial<Record<ClientCacheKind, number>>>;
}

export interface ClientCacheSummary {
  readonly recordCount: number;
  readonly payloadBytes: number;
  readonly environments: ReadonlyArray<EnvironmentClientCacheSummary>;
}

export type ClientCacheClearScope =
  | { readonly type: "all" }
  | { readonly type: "environment"; readonly environmentId: EnvironmentId };

function aggregateCacheSummary(
  rows: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly kind: ClientCacheKind;
    readonly recordCount: number;
    readonly payloadBytes: number;
  }>,
): ClientCacheSummary {
  const environments = new Map<EnvironmentId, EnvironmentClientCacheSummary>();
  let recordCount = 0;
  let payloadBytes = 0;

  for (const row of rows) {
    recordCount += row.recordCount;
    payloadBytes += row.payloadBytes;
    const current = environments.get(row.environmentId) ?? {
      environmentId: row.environmentId,
      recordCount: 0,
      payloadBytes: 0,
      kinds: {},
    };
    environments.set(row.environmentId, {
      environmentId: row.environmentId,
      recordCount: current.recordCount + row.recordCount,
      payloadBytes: current.payloadBytes + row.payloadBytes,
      kinds: { ...current.kinds, [row.kind]: row.recordCount },
    });
  }

  return {
    recordCount,
    payloadBytes,
    environments: [...environments.values()],
  };
}

const clientCacheRuntime = Atom.runtime(Runtime.runtimeContextLayer);

export const clientCacheSummaryAtom = clientCacheRuntime
  .atom(
    MobileDatabase.pipe(
      Effect.flatMap((database) => database.inspectCaches),
      Effect.map(aggregateCacheSummary),
    ),
  )
  .pipe(Atom.withLabel("mobile:client-cache:summary"));

export const clearClientCacheAtom = clientCacheRuntime
  .fn((scope: ClientCacheClearScope, get) =>
    MobileDatabase.pipe(
      Effect.flatMap((database) =>
        scope.type === "all"
          ? database.clearAllCaches
          : database.clearEnvironmentCache(scope.environmentId),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          get.refresh(clientCacheSummaryAtom);
        }),
      ),
    ),
  )
  .pipe(Atom.withLabel("mobile:client-cache:clear"));
