import { useAtomValue } from "@effect/atom-react";
import {
  AuthRelayReadScope,
  type EnvironmentCloudLinkStateResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { readCloudLinkState, type CloudLinkTarget } from "./linkEnvironment";
import { hasCloudPublicConfig } from "./publicConfig";

const cloudLinkStateAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(readCloudLinkState({ target: { environmentId } }))
    .pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`cloud-link:${environmentId}`),
    ),
);

const EMPTY_CLOUD_LINK_STATE_ATOM = Atom.make(
  AsyncResult.success<EnvironmentCloudLinkStateResult | null>(null),
).pipe(Atom.keepAlive, Atom.withLabel("cloud-link:null"));

function refreshCloudLinkState(target: CloudLinkTarget | null): void {
  if (target && readEnvironmentScope(target.environmentId, AuthRelayReadScope)) {
    appAtomRegistry.refresh(cloudLinkStateAtom(target.environmentId));
  }
}

export function readCachedCloudLinkState(target: CloudLinkTarget) {
  if (!readEnvironmentScope(target.environmentId, AuthRelayReadScope)) return null;
  const result = appAtomRegistry.get(cloudLinkStateAtom(target.environmentId));
  return result._tag === "Success" ? result.value : null;
}

export function useCloudLinkState(environmentId: EnvironmentId | null) {
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const target: CloudLinkTarget | null = environmentId === null ? null : { environmentId };
  const atom =
    environmentId !== null && hasCloudPublicConfig() && canReadRelay
      ? cloudLinkStateAtom(environmentId)
      : EMPTY_CLOUD_LINK_STATE_ATOM;
  const result = useAtomValue(atom);
  const refresh = () => {
    refreshCloudLinkState(target);
  };
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read T3 Connect link state.";
  }

  return {
    data: result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null),
    error,
    isPending: result.waiting,
    refresh,
    target,
  };
}

export function usePrimaryCloudLinkState() {
  return useCloudLinkState(usePrimaryEnvironmentId());
}
