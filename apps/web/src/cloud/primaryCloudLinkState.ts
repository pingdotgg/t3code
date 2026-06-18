import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";
import { useCallback, useMemo } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPrimaryCloudLinkState, type CloudLinkTarget } from "./linkEnvironment";

const primaryCloudLinkAtomRuntime = Atom.runtime(
  Layer.effect(
    HttpClient.HttpClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, HttpClient.HttpClient)),
    ),
  ),
);

const primaryCloudLinkStateAtom = Atom.family((key: string) => {
  const target = JSON.parse(key) as CloudLinkTarget;
  return primaryCloudLinkAtomRuntime
    .atom(readPrimaryCloudLinkState({ target }))
    .pipe(
      Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`primary-cloud-link:${target.environmentId}`),
    );
});

const EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM = Atom.make(
  AsyncResult.success<EnvironmentCloudLinkStateResult | null>(null),
).pipe(Atom.keepAlive, Atom.withLabel("primary-cloud-link:null"));

function targetKey(target: CloudLinkTarget): string {
  return JSON.stringify(target);
}

export function refreshPrimaryCloudLinkState(target: CloudLinkTarget | null): void {
  if (target) {
    appAtomRegistry.refresh(primaryCloudLinkStateAtom(targetKey(target)));
  }
}

export function usePrimaryCloudLinkState() {
  const primary = usePrimaryEnvironment();
  const target = useMemo(
    () =>
      primary?.entry.target._tag === "PrimaryConnectionTarget"
        ? {
            environmentId: primary.environmentId,
            label: primary.label,
            httpBaseUrl: primary.entry.target.httpBaseUrl,
            wsBaseUrl: primary.entry.target.wsBaseUrl,
          }
        : null,
    [primary],
  );
  const atom = target
    ? primaryCloudLinkStateAtom(targetKey(target))
    : EMPTY_PRIMARY_CLOUD_LINK_STATE_ATOM;
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    refreshPrimaryCloudLinkState(target);
  }, [target]);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read T3 Connect link state.";
  }

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    isPending: result.waiting,
    refresh,
    target,
  };
}
