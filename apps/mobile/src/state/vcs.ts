import type { EnvironmentId, VcsStatusLocalResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import {
  resolveVcsTerminology,
  resolveVcsUnsupportedReason,
  type VcsTerminology,
} from "@t3tools/shared/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuerySelector } from "./query";
import { appAtomRegistry } from "./atom-registry";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

export const selectTerminology = (result: AsyncResult.AsyncResult<VcsStatusLocalResult, unknown>) =>
  resolveVcsTerminology(Option.getOrNull(AsyncResult.value(result)));
export const selectUnsupportedReason = (
  result: AsyncResult.AsyncResult<VcsStatusLocalResult, unknown>,
) => resolveVcsUnsupportedReason(Option.getOrNull(AsyncResult.value(result)));
export const selectKind = (result: AsyncResult.AsyncResult<VcsStatusLocalResult, unknown>) =>
  Option.getOrNull(AsyncResult.value(result))?.vcs?.kind ?? null;
export const selectNotice = (result: AsyncResult.AsyncResult<VcsStatusLocalResult, unknown>) => {
  const vcs = Option.getOrNull(AsyncResult.value(result))?.vcs;
  return vcs?.kind === "git" ? (vcs.notice ?? null) : null;
};

/** Terminology readers use local status so they never keep remote polling alive. */
export function useVcsTerminology(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): VcsTerminology {
  return useEnvironmentQuerySelector(
    environmentId === null || cwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
    selectTerminology,
  );
}

export function readVcsUnsupportedReason(environmentId: EnvironmentId, cwd: string): string | null {
  const status = appAtomRegistry.get(
    vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
  );
  return resolveVcsUnsupportedReason(Option.getOrNull(AsyncResult.value(status)));
}

export function useVcsActionSupport(environmentId: EnvironmentId | null, cwd: string | null) {
  const unsupportedReason = useEnvironmentQuerySelector(
    environmentId === null || cwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
    selectUnsupportedReason,
  );
  return {
    supported: unsupportedReason === null,
    unsupportedReason,
    canUseVcsActions: () =>
      environmentId === null ||
      cwd === null ||
      readVcsUnsupportedReason(environmentId, cwd) === null,
  };
}
