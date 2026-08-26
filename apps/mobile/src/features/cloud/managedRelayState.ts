import { useAtomValue } from "@effect/atom-react";
import {
  claimManagedRelayReferral,
  createManagedRelayQueryManager,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
} from "@t3tools/client-runtime/relay";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
  RelayReferralSummary,
} from "@t3tools/contracts/relay";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { runtimeContextLayer } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { cloudDebugLog } from "./cloudDebugLog";

const managedRelayAtomRuntime = Atom.runtime(runtimeContextLayer);

export const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime, {
  onQueryEvent: (event) =>
    cloudDebugLog(`query:${event.operation}:${event.stage}:${event.phase}`, { ...event }),
});

const managedRelayMutationScheduler = createAtomCommandScheduler();

export const claimManagedRelayReferralCommand = createRuntimeCommand(managedRelayAtomRuntime, {
  label: "mobile:managed-relay:claim-referral",
  scheduler: managedRelayMutationScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly accountId: string; readonly referralCode: string }) => input.accountId,
  },
  execute: (input, registry) => claimManagedRelayReferral(registry, input),
});

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environments:null"));

const EMPTY_ENVIRONMENT_STATUS_ATOM = Atom.make(
  AsyncResult.initial<RelayEnvironmentStatusResponse, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environment-status:null"));

const EMPTY_REFERRAL_SUMMARY_ATOM = Atom.make(
  AsyncResult.initial<RelayReferralSummary, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:referrals:null"));

export function useManagedRelayEnvironments() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentsAtom(accountId)
    : EMPTY_ENVIRONMENTS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  useEffect(() => {
    if (snapshot.error) {
      console.error("[t3-cloud] Relay environment listing failed", {
        message: snapshot.error,
        traceId: snapshot.errorTraceId,
      });
    }
  }, [snapshot.error, snapshot.errorTraceId]);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
    }
  }, [accountId]);

  return {
    ...snapshot,
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
  const snapshot = readManagedRelaySnapshotState(result);
  useEffect(() => {
    if (snapshot.error) {
      console.error("[t3-cloud] Relay environment status failed", {
        environmentId: environment.environmentId,
        message: snapshot.error,
        traceId: snapshot.errorTraceId,
      });
    }
  }, [environment.environmentId, snapshot.error, snapshot.errorTraceId]);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironmentStatus(appAtomRegistry, {
        accountId,
        environment,
      });
    }
  }, [accountId, environment]);

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

export function useManagedRelayReferralSummary() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.referralSummaryAtom(accountId)
    : EMPTY_REFERRAL_SUMMARY_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  useEffect(() => {
    if (snapshot.error) {
      console.error("[t3-cloud] Relay referral summary failed", {
        message: snapshot.error,
        traceId: snapshot.errorTraceId,
      });
    }
  }, [snapshot.error, snapshot.errorTraceId]);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshReferralSummary(appAtomRegistry, accountId);
    }
  }, [accountId]);

  return {
    ...snapshot,
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

export function refreshManagedRelayReferralSummary(): void {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (session) {
    managedRelayQueryManager.refreshReferralSummary(appAtomRegistry, session.accountId);
  }
}
