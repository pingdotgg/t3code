import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
  type SourceControlDiscoveryState,
  createSourceControlDiscoveryManager,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
} from "@t3tools/client-runtime";
import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const SOURCE_CONTROL_DISCOVERY_TARGET = { key: "primary" } as const;
const SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS = 30_000;
const SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS = 5 * 60_000;

export const sourceControlDiscoveryManager = createSourceControlDiscoveryManager({
  getRegistry: () => appAtomRegistry,
  getClient: () => readLocalApi()?.server ?? null,
});

const sourceControlDiscoveryAutoRefreshAtom = Atom.make(() =>
  Effect.promise(() => refreshSourceControlDiscovery()),
).pipe(
  Atom.swr({
    staleTime: SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS),
  Atom.withLabel("source-control-discovery:auto-refresh"),
);

export function refreshSourceControlDiscovery(): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(SOURCE_CONTROL_DISCOVERY_TARGET);
}

export function resetSourceControlDiscoveryStateForTests(): void {
  sourceControlDiscoveryManager.reset();
}

export function useSourceControlDiscovery(): SourceControlDiscoveryState {
  const targetKey = getSourceControlDiscoveryTargetKey(SOURCE_CONTROL_DISCOVERY_TARGET);

  useAtomValue(sourceControlDiscoveryAutoRefreshAtom);

  const state = useAtomValue(
    targetKey !== null
      ? sourceControlDiscoveryStateAtom(targetKey)
      : EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  );
  return targetKey === null ? EMPTY_SOURCE_CONTROL_DISCOVERY_STATE : state;
}
