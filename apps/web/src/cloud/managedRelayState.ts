import { useAtomValue } from "@effect/atom-react";
import {
  createManagedRelayQueryManager,
  createManagedRelayT3ChatLinkRequest,
  deregisterManagedRelayEnvironment,
  ManagedRelay,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
  unlinkManagedRelayT3Chat,
} from "@t3tools/client-runtime/relay";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_MANAGED_TUNNEL_LIMIT,
  T3CHAT_PLAN_TUNNEL_LIMITS,
  type RelayClientDeviceRecord,
  type RelayClientEnvironmentRecord,
  type RelayT3ChatLinkResponse,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/reactivity";

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

const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime);

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

const accountSerial = {
  mode: "serial",
  key: (input: { readonly accountId: string }) => input.accountId,
} as const;

export const createManagedRelayT3ChatLinkRequestCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:create-t3chat-link-request",
    scheduler: managedRelayMutationScheduler,
    concurrency: accountSerial,
    execute: (input: { readonly accountId: string }, registry) =>
      createManagedRelayT3ChatLinkRequest(registry, input),
  },
);

export const unlinkManagedRelayT3ChatCommand = createRuntimeCommand(managedRelayAtomRuntime, {
  label: "web:managed-relay:unlink-t3chat",
  scheduler: managedRelayMutationScheduler,
  concurrency: accountSerial,
  execute: (input: { readonly accountId: string }, registry) =>
    unlinkManagedRelayT3Chat(registry, input),
});

const EMPTY_T3CHAT_LINK_ATOM = Atom.make(
  AsyncResult.success<RelayT3ChatLinkResponse>({ available: false, link: null }),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:t3chat-link:null"));

export function useManagedRelayT3ChatLink() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.t3ChatLinkAtom(accountId)
    : EMPTY_T3CHAT_LINK_ATOM;
  const snapshot = readManagedRelaySnapshotState(useAtomValue(atom));
  const refresh = () => {
    if (accountId) {
      managedRelayQueryManager.refreshT3ChatLink(appAtomRegistry, accountId);
    }
  };

  return { ...snapshot, accountId, refresh };
}

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:environments:null"));

const EMPTY_DEVICES_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientDeviceRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:devices:null"));

export function useManagedRelayEnvironments() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentsAtom(accountId)
    : EMPTY_ENVIRONMENTS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  const refresh = () => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
    }
  };

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
  const refresh = () => {
    if (accountId) {
      managedRelayQueryManager.refreshDevices(appAtomRegistry, accountId);
    }
  };

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

/** How this account can raise its tunnel cap: link T3 Chat, or upgrade the linked plan. */
export type ManagedTunnelUpgrade = "link" | "pro" | "premier" | null;

// Mirrors the relay's cap without manual overrides, which the relay does not expose.
function managedTunnelCap(t3Chat: RelayT3ChatLinkResponse): {
  readonly limit: number;
  readonly upgrade: ManagedTunnelUpgrade;
} {
  if (!t3Chat.available) return { limit: DEFAULT_MANAGED_TUNNEL_LIMIT, upgrade: null };
  switch (t3Chat.link?.plan) {
    case "premier":
      return { limit: T3CHAT_PLAN_TUNNEL_LIMITS.premier, upgrade: null };
    case "pro":
      return { limit: T3CHAT_PLAN_TUNNEL_LIMITS.pro, upgrade: "premier" };
    case "free":
      return { limit: DEFAULT_MANAGED_TUNNEL_LIMIT, upgrade: "pro" };
    case undefined:
      return { limit: DEFAULT_MANAGED_TUNNEL_LIMIT, upgrade: "link" };
  }
}

/** Refetches the account's environments and T3 Chat plan after a tunnel changes. */
export function refreshManagedTunnelUsage() {
  const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
  if (!accountId) return;
  managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
  managedRelayQueryManager.refreshT3ChatLink(appAtomRegistry, accountId);
}

/** Managed tunnels on this account and its cap. Null fields are still loading or failed. */
export function useManagedTunnelUsage() {
  const environments = useManagedRelayEnvironments();
  const t3Chat = useManagedRelayT3ChatLink();
  const used =
    environments.accountId === null
      ? null
      : (environments.data?.filter(
          (environment) => environment.endpoint.providerKind === "cloudflare_tunnel",
        ).length ?? null);
  const cap = t3Chat.accountId !== null && t3Chat.data ? managedTunnelCap(t3Chat.data) : null;
  return {
    used,
    limit: cap?.limit ?? null,
    upgrade: cap?.upgrade ?? null,
    refresh: refreshManagedTunnelUsage,
  };
}
