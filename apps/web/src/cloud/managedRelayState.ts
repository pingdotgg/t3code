import { useAtomValue } from "@effect/atom-react";
import {
  createManagedRelayQueryManager,
  claimManagedRelayReferral,
  deregisterManagedRelayEnvironment,
  ManagedRelay,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
} from "@t3tools/client-runtime/relay";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  RelayClientDeviceRecord,
  RelayClientEnvironmentRecord,
  RelayReferralSummary,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const managedRelayAtomRuntime = Atom.runtime(
  Layer.effect(
    ManagedRelay.ManagedRelayClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, ManagedRelay.ManagedRelayClient)),
    ),
  ),
);

export const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime);

const managedRelayMutationScheduler = createAtomCommandScheduler();

export const deregisterManagedRelayEnvironmentCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:deregister-environment",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: { readonly accountId: string; readonly environmentId: EnvironmentId }) =>
        input.accountId,
    },
    execute: (input, registry) => deregisterManagedRelayEnvironment(registry, input),
  },
);

export const claimManagedRelayReferralCommand = createRuntimeCommand(managedRelayAtomRuntime, {
  label: "web:managed-relay:claim-referral",
  scheduler: managedRelayMutationScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly accountId: string; readonly referralCode: string }) => input.accountId,
  },
  execute: (input, registry) => claimManagedRelayReferral(registry, input),
});

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:environments:null"));

const EMPTY_DEVICES_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientDeviceRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:devices:null"));

const EMPTY_REFERRAL_SUMMARY_ATOM = Atom.make(
  AsyncResult.initial<RelayReferralSummary, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:referrals:null"));

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

export function useManagedRelayDevices() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId ? managedRelayQueryManager.devicesAtom(accountId) : EMPTY_DEVICES_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  useEffect(() => {
    if (snapshot.error) {
      console.error("[t3-cloud] Relay device listing failed", {
        message: snapshot.error,
        traceId: snapshot.errorTraceId,
      });
    }
  }, [snapshot.error, snapshot.errorTraceId]);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshDevices(appAtomRegistry, accountId);
    }
  }, [accountId]);

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
