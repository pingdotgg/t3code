import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useContext, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useSettingsScope } from "./SettingsScopeContext";
import { combineStorageUsage } from "./storageUsage";

/** Each selected server owns its scan and cache. A failed server never hides successful results. */
export function useStorageUsage(inactiveAfterDays?: number | null) {
  const { targets, environments, connectedEnvironments } = useSettingsScope();
  const registry = useContext(RegistryContext);
  const queries = useMemo(() => {
    const supported = new Set(
      connectedEnvironments
        .filter(
          (environment) =>
            environment.serverConfig?.environment.capabilities.storageCleanupPreview === true,
        )
        .map((environment) => environment.environmentId),
    );
    return targets
      .filter((target) => supported.has(target.environmentId))
      .map((target) => ({
        label: target.label,
        atom: serverEnvironment.storageUsage({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            ...(inactiveAfterDays === undefined ? {} : { inactiveAfterDays }),
          },
        }),
      }));
  }, [targets, connectedEnvironments, inactiveAfterDays]);
  const resultsAtom = useMemo(
    () => Atom.make((get) => queries.map(({ atom }) => get(atom))),
    [queries],
  );
  const results = useAtomValue(resultsAtom);
  const summaries = useMemo(
    () =>
      results.flatMap((result) => {
        if (result._tag === "Failure") return [];
        const data = Option.getOrNull(AsyncResult.value(result));
        return data ? [data] : [];
      }),
    [results],
  );
  const currentData = useMemo(() => combineStorageUsage(summaries), [summaries]);
  const offline = environments
    .filter((environment) => !connectedEnvironments.includes(environment))
    .map((environment) => environment.label);
  const unsupported = connectedEnvironments
    .filter(
      (environment) =>
        environment.serverConfig?.environment.capabilities.storageCleanupPreview !== true,
    )
    .map((environment) => environment.label);
  const failed = [
    ...new Set(
      results.flatMap((result, index) =>
        result._tag === "Failure" ? [queries[index]!.label] : [],
      ),
    ),
  ];
  const isPending = results.some((result) => result.waiting || result._tag === "Initial");
  const partial =
    offline.length > 0 ||
    unsupported.length > 0 ||
    failed.length > 0 ||
    summaries.length < queries.length;
  const scopeKey = JSON.stringify([
    targets.map(({ environmentId, projectId }) => [environmentId, projectId]),
    offline,
    unsupported,
  ]);
  const [settled, setSettled] = useState({
    scopeKey,
    data: currentData,
    partial,
    inactiveAfterDays,
  });
  // Keep one coherent breakdown while a new retention preview is being calculated.
  // Never carry measurements across scope or connection changes.
  if (
    settled.scopeKey !== scopeKey ||
    (!isPending &&
      (settled.data !== currentData ||
        settled.partial !== partial ||
        settled.inactiveAfterDays !== inactiveAfterDays))
  ) {
    setSettled({ scopeKey, data: currentData, partial, inactiveAfterDays });
  }
  const previous =
    isPending && failed.length === 0 && settled.scopeKey === scopeKey && settled.data !== null
      ? settled
      : null;
  return {
    data: previous ? previous.data : currentData,
    isPending,
    recalculatingInactive:
      isPending && settled.scopeKey === scopeKey && settled.inactiveAfterDays !== inactiveAfterDays,
    partial: previous ? previous.partial : partial,
    offline,
    unsupported,
    failed,
    canRefresh: queries.length > 0,
    refresh: () => {
      for (const { atom } of queries) registry.refresh(atom);
    },
  };
}
