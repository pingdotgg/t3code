import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentCloudLinkStateResult, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";
import { useCallback } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { webRuntime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPrimaryCloudLinkState } from "./linkEnvironment";

const primaryCloudLinkAtomRuntime = Atom.runtime(
  Layer.effect(
    HttpClient.HttpClient,
    webRuntime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, HttpClient.HttpClient)),
    ),
  ),
);

const primaryCloudLinkStateAtom = Atom.family((environmentId: EnvironmentId) =>
  primaryCloudLinkAtomRuntime
    .atom(readPrimaryCloudLinkState())
    .pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`primary-cloud-link:${environmentId}`),
    ),
);

const EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM = Atom.make(
  AsyncResult.success<EnvironmentCloudLinkStateResult | null>(null),
).pipe(Atom.keepAlive, Atom.withLabel("primary-cloud-link:null"));

export function refreshPrimaryCloudLinkState(environmentId: EnvironmentId | null): void {
  if (environmentId) {
    appAtomRegistry.refresh(primaryCloudLinkStateAtom(environmentId));
  }
}

export function usePrimaryCloudLinkState() {
  const environmentId = usePrimaryEnvironmentId();
  const atom = environmentId
    ? primaryCloudLinkStateAtom(environmentId)
    : EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM;
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    refreshPrimaryCloudLinkState(environmentId);
  }, [environmentId]);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read T3 Cloud link state.";
  }

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    isPending: result.waiting,
    refresh,
  };
}
