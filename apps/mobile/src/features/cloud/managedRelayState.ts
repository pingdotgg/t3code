import { useAtomValue } from "@effect/atom-react";
import {
  createManagedRelayQueryManager,
  ManagedRelayClient,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
} from "@t3tools/client-runtime";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { mobileRuntime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

const managedRelayAtomRuntime = Atom.runtime(
  Layer.effect(
    ManagedRelayClient,
    mobileRuntime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, ManagedRelayClient)),
    ),
  ),
);

export const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime);

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environments:null"));

const EMPTY_ENVIRONMENT_STATUS_ATOM = Atom.make(
  AsyncResult.initial<RelayEnvironmentStatusResponse, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environment-status:null"));

export function useManagedRelayEnvironments() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentsAtom(accountId)
    : EMPTY_ENVIRONMENTS_ATOM;
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
    }
  }, [accountId]);

  return {
    ...readManagedRelaySnapshotState(result),
    accountId,
    refresh,
  };
}

export function useManagedRelayEnvironmentStatus(environment: RelayClientEnvironmentRecord) {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentStatusAtom({ accountId, environment })
    : EMPTY_ENVIRONMENT_STATUS_ATOM;
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironmentStatus(appAtomRegistry, {
        accountId,
        environment,
      });
    }
  }, [accountId, environment]);

  return {
    ...readManagedRelaySnapshotState(result),
    accountId,
    refresh,
  };
}

export function refreshManagedRelayEnvironments(): void {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (session) {
    managedRelayQueryManager.refreshEnvironments(appAtomRegistry, session.accountId);
  }
}
