import {
  createCredentialRefusalWatch,
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  forgetOrbitEnvironment,
  forgetPairingRevoked,
  forgetRenewalFailure,
  isFinalPairingError,
  isPairingRevokedError,
  isReservedOrbitEnvironment,
  orbitInstanceFromEnvironment,
  orbitInstancesByEnvironment,
  parseEnvironmentProvider,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  preferredOrbitInstance,
  readSessionRenewals,
  recordAccessPairing,
  recordPaired,
  recordPairingAttempt,
  recordPairingRefused,
  recordPairingRevoked,
  recordRenewal,
  recordRenewalFailed,
  renewalFailureReason,
  type EnvironmentProvider,
  type OrbitEnvironmentState,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  OrbitInstanceDescriptor,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "../state/entities";
import { environmentSession, readEnvironmentLacksScope } from "../state/session";
import { observeOrbitInstancePower } from "./orbitInstanceSleep";
import { rememberedCloneEnvironmentIds } from "./cloneWorkspaceRefs";
import { dropOrbitInstanceStarts, heldOrbitInstanceIds } from "./orbitThreadStartStore";

const PROVIDER_STORAGE_KEY = "t3code:environment-provider:v1";
const STATE_STORAGE_KEY = "t3code:orbit-environments:v1";
const INSTANCES_STORAGE_KEY = "t3code:orbit-instances:v1";

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

interface EnvironmentProviderStore {
  readonly provider: EnvironmentProvider;
  readonly state: OrbitEnvironmentState;
  /** Conn: the Gateway's Orbit facts of each clone, from the last sync, so the row shows at start. */
  readonly orbitInstances: Readonly<Record<string, OrbitInstanceDescriptor>>;
}

const decodeOrbitInstance = Schema.decodeUnknownOption(OrbitInstanceDescriptor);

function parseOrbitInstances(value: unknown): Record<string, OrbitInstanceDescriptor> {
  const result: Record<string, OrbitInstanceDescriptor> = {};
  if (typeof value !== "object" || value === null) return result;
  for (const [environmentId, entry] of Object.entries(value)) {
    const decoded = decodeOrbitInstance(entry);
    if (decoded._tag === "None") continue;
    // The Gateway's own rule again, so a stored URL other than http(s) never comes back.
    const { url, ...facts } = decoded.value;
    const descriptor = orbitInstanceFromEnvironment({
      ...facts,
      projectSlug: facts.projectSlug ?? null,
      projectName: facts.projectName ?? null,
      instanceName: facts.instanceName ?? null,
      nodeName: facts.nodeName ?? null,
      instanceUrl: url ?? null,
    });
    if (descriptor) result[environmentId] = descriptor;
  }
  return result;
}

/** This device's environment provider (see planEnvironmentProvider), kept in localStorage. */
export const useEnvironmentProvider = create<EnvironmentProviderStore>(() => ({
  provider: parseEnvironmentProvider(readJson(PROVIDER_STORAGE_KEY)),
  state: parseOrbitEnvironmentState(readJson(STATE_STORAGE_KEY) ?? EMPTY_ORBIT_ENVIRONMENT_STATE),
  orbitInstances: parseOrbitInstances(readJson(INSTANCES_STORAGE_KEY)),
}));

useEnvironmentProvider.subscribe((next, previous) => {
  if (next.provider !== previous.provider) {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next.provider));
  }
  if (next.state !== previous.state) {
    window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(next.state));
  }
  if (next.orbitInstances !== previous.orbitInstances) {
    window.localStorage.setItem(INSTANCES_STORAGE_KEY, JSON.stringify(next.orbitInstances));
  }
});

/** Keeps the old object when nothing changed, so a sync does not re-render the thread panel. */
function saveOrbitInstances(next: Record<string, OrbitInstanceDescriptor>): void {
  const { orbitInstances } = useEnvironmentProvider.getState();
  if (JSON.stringify(next) === JSON.stringify(orbitInstances)) return;
  useEnvironmentProvider.setState({ orbitInstances: next });
}

/**
 * Conn: the Orbit Instance a server runs in. The Gateway's record comes first, because clones run
 * the stock T3 server; a fork server's own descriptor is the fallback (see FORK.md, "Orbit").
 */
export function useOrbitInstance(
  environmentId: EnvironmentId | null,
): OrbitInstanceDescriptor | undefined {
  const gateway = useEnvironmentProvider((store) =>
    environmentId === null ? undefined : store.orbitInstances[environmentId],
  );
  const configs = useServerConfigs();
  const server = environmentId === null ? undefined : configs.get(environmentId)?.environment;
  return preferredOrbitInstance(gateway, server?.orbitInstance);
}

/** Conn: thread starts in Orbit Projects need the desktop's Gateway client and the Orbit provider. */
export function useOrbitThreadsAvailable(): boolean {
  const provider = useEnvironmentProvider((state) => state.provider);
  return window.desktopBridge?.orbitGatewaySend !== undefined && provider === "orbit";
}

/** `useOrbitThreadsAvailable` outside React: the desktop app in Orbit mode right now. */
export function orbitThreadsAvailableNow(): boolean {
  return (
    window.desktopBridge?.orbitGatewaySend !== undefined &&
    useEnvironmentProvider.getState().provider === "orbit"
  );
}

export function setEnvironmentProvider(provider: EnvironmentProvider): void {
  useEnvironmentProvider.setState({ provider });
}

/** Conn: a thread start paired with its clone's server, which Orbit provides like any other. */
export function recordOrbitPaired(environmentId: string): void {
  useEnvironmentProvider.setState(({ state }) => ({ state: recordPaired(state, environmentId) }));
}

/** Conn: the saved servers of an Instance, as the last sync saw them. */
export function orbitInstanceEnvironmentIds(instanceId: number): string[] {
  return Object.entries(useEnvironmentProvider.getState().orbitInstances)
    .filter(([, descriptor]) => descriptor.instanceId === instanceId)
    .map(([environmentId]) => environmentId);
}

/** Conn: forgets a server Orbit removed: its pairing records and its Orbit facts. */
export function forgetOrbitInstanceEnvironment(environmentId: string): void {
  useEnvironmentProvider.setState(({ state, orbitInstances }) => {
    const { [environmentId]: _gone, ...rest } = orbitInstances;
    return { state: forgetOrbitEnvironment(state, environmentId), orbitInstances: rest };
  });
}

/**
 * Saves a reconcile run's switches. Pairing records come from the store, so a thread start or a
 * Connect that ran during the run keeps its own.
 */
function saveReconciledState(next: OrbitEnvironmentState): void {
  useEnvironmentProvider.setState(({ state: current }) => ({
    state: next.pairedByOrbit.reduce(recordPaired, {
      ...current,
      disabledByOrbit: next.disabledByOrbit,
      instanceServers: next.instanceServers ?? {},
      missingFromGateway: next.missingFromGateway ?? {},
    }),
  }));
}

/**
 * Conn: removes the server of an Instance that left the Gateway's list from this device, as the
 * Orbit panel does when the user removes the Instance: the saved server, its pairing records and
 * Orbit facts, and the thread starts that wait for it.
 */
async function removeGoneInstanceServer(environmentId: string, instanceId: number | null) {
  dropOrbitInstanceStarts(instanceId, [environmentId]);
  await runAtomCommand(appAtomRegistry, environmentCatalog.remove, environmentId as EnvironmentId, {
    reportFailure: false,
  });
  // Forgotten even when the removal failed: a later sync, which still knows it as an Instance's
  // server, removes it again once lists leave it out long enough.
  forgetOrbitInstanceEnvironment(environmentId);
}

function updateState(change: (state: OrbitEnvironmentState) => OrbitEnvironmentState): void {
  useEnvironmentProvider.setState(({ state }) => ({ state: change(state) }));
}

const pairings = new Map<string, Promise<boolean>>();

/**
 * Conn: why this device pairs a server. `new`: not saved yet. `access`: saved, but its session
 * cannot manage access. `renew`: saved, and its session ends soon or has ended. `connect`: the
 * user asked for it (the only kind that pairs a server Orbit revoked again).
 */
type PairingKind = "new" | "access" | "renew" | "connect";

/**
 * Conn: pairs this device with one Orbit server and records the attempt and its result. Resolves
 * true when the server is saved. A second call while one runs joins it.
 */
function pairOne(
  client: OrbitGatewayClient,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  kind: PairingKind,
): Promise<boolean> {
  const { environmentId } = environment;
  const running = pairings.get(environmentId);
  if (running) return running;
  const pairing = attemptPairing(client, environment, kind).finally(() =>
    pairings.delete(environmentId),
  );
  pairings.set(environmentId, pairing);
  return pairing;
}

async function attemptPairing(
  client: OrbitGatewayClient,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  kind: PairingKind,
): Promise<boolean> {
  const { environmentId } = environment;
  const now = Date.now();
  try {
    // Recorded before the attempt, so a reload during the pairing still backs off.
    updateState((state) => {
      switch (kind) {
        case "new":
          return recordPairingAttempt(state, environmentId, now);
        case "access":
          return recordAccessPairing(state, environmentId, now);
        case "renew":
          return recordRenewal(state, environmentId, now);
        case "connect":
          // Backs off like a new server, so a failed Connect is not retried on every refresh.
          return recordPairingAttempt(
            forgetPairingRevoked(state, environmentId),
            environmentId,
            now,
          );
      }
    });
    // Every automatic pairing of a saved server is a renewal to Orbit, so a revoke stops it.
    const pairing = await client.pair(environmentId, {
      renew: kind === "access" || kind === "renew",
    });
    const result = await runAtomCommand(
      appAtomRegistry,
      connectPairing,
      { pairingUrl: pairing.pairingUrl },
      { reportFailure: false },
    );
    if (result._tag !== "Success") {
      if (kind === "renew") recordFailedRenewal(environmentId, squashAtomCommandFailure(result));
      return false;
    }
    updateState((state) => forgetRenewalFailure(recordPaired(state, environmentId), environmentId));
    return true;
  } catch (error) {
    // Revoked in Orbit: never again on its own. Unreachable: a later run. Refused: after the
    // server registers again.
    if (isPairingRevokedError(error)) {
      updateState((state) => recordPairingRevoked(state, environmentId, Date.now()));
    } else if (isFinalPairingError(error)) {
      updateState((state) => recordPairingRefused(state, environment));
    }
    // A revoked server shows "Revoked in Orbit" with Connect instead.
    if (kind === "renew" && !isPairingRevokedError(error))
      recordFailedRenewal(environmentId, error);
    return false;
  }
}

/** Conn: a renewal failed; the server's row says why, with a Retry, until a pairing succeeds. */
function recordFailedRenewal(environmentId: string, error: unknown): void {
  updateState((state) =>
    recordRenewalFailed(state, environmentId, {
      at: Date.now(),
      reason: renewalFailureReason(error),
    }),
  );
}

/**
 * Conn: the Retry of a failed renewal: renews that server now, without the planner's wait.
 * Resolves true when the server is saved with its new session.
 */
export function retryOrbitRenewal(
  client: OrbitGatewayClient,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
): Promise<boolean> {
  return pairOne(client, environment, "renew");
}

/**
 * Conn: the explicit Connect for a server, the one way back after Orbit revoked its pairing.
 * Resolves true when the server is saved.
 */
export function connectOrbitEnvironment(
  client: OrbitGatewayClient,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
): Promise<boolean> {
  return pairOne(client, environment, "connect");
}

/** Conn: a saved server's connection, as the shared renewal reader and refusal watch read it. */
function readConnection(environmentId: string) {
  return Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(environmentCatalog.stateAtom(environmentId as EnvironmentId)),
    ),
  );
}

/** Conn: a saved server's session, or null while it is unread or failed. */
function readSession(environmentId: string) {
  const result = appAtomRegistry.get(
    environmentSession.sessionStateAtom(environmentId as EnvironmentId),
  );
  return result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
}

const refusalListeners = new Set<() => void>();

/**
 * Conn: calls `listener` each time a saved Orbit server starts refusing this device's credential,
 * so the sync renews it at once instead of at the next poll. Returns the unsubscribe.
 */
export function onOrbitCredentialRefused(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => refusalListeners.delete(listener);
}

const refusalWatch = createCredentialRefusalWatch({
  subscribe: (environmentId, listener) =>
    appAtomRegistry.subscribe(
      environmentCatalog.stateAtom(environmentId as EnvironmentId),
      (result) => listener(Option.getOrNull(AsyncResult.value(result))),
    ),
  onRefused: () => {
    if (useEnvironmentProvider.getState().provider !== "orbit") return;
    for (const listener of refusalListeners) listener();
  },
});

/** Conn: the renewals of one sync, one after another; a later sync while it runs adds none. */
let renewing: Promise<void> | null = null;

function renewInOrder(
  client: OrbitGatewayClient,
  environments: readonly OrbitGatewayEnvironment[],
): void {
  if (renewing || environments.length === 0) return;
  renewing = (async () => {
    for (const environment of environments) {
      if (!pairings.has(environment.environmentId)) await pairOne(client, environment, "renew");
    }
  })().finally(() => {
    renewing = null;
  });
}

/**
 * Brings the saved environments in line with the provider: Orbit mode turns the default
 * environments off and pairs the Gateway's host servers and the clones the user connected;
 * Default mode undoes both. The desktop's own local backend is left alone. Returns the Gateway's server list when Orbit mode read it.
 */
export async function reconcileEnvironmentProvider(
  client: OrbitGatewayClient,
): Promise<readonly OrbitGatewayEnvironment[] | null> {
  const { provider, state } = useEnvironmentProvider.getState();
  const orbit = provider === "orbit" ? await client.environments() : null;
  // Conn: reserved clones stay out of every list until finalized; the plan below still sees them.
  saveOrbitInstances(
    orbit === null
      ? {}
      : orbitInstancesByEnvironment(orbit.filter((row) => !isReservedOrbitEnvironment(row))),
  );
  // Conn: asleep Instances nobody uses stay unconnected; one in use is woken.
  await observeOrbitInstancePower(client, orbit);
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return orbit;

  const saved = [...catalog.entries.entries()]
    .filter(([, entry]) => entry.target._tag !== "PrimaryConnectionTarget")
    .map(([environmentId, entry]) => ({
      environmentId: String(environmentId),
      enabled: entry.enabled,
    }));
  // Conn: sessions Orbit paired before the Gateway asked for admin scopes cannot manage access.
  const lacksAccess = saved
    .filter((entry) =>
      readEnvironmentLacksScope(entry.environmentId as EnvironmentId, AuthAccessWriteScope),
    )
    .map((entry) => entry.environmentId);
  const now = Date.now();
  // Conn: only bearer sessions, the kind a pairing gives; a new pairing cannot fix a relay or SSH
  // connection's sign-in.
  const bearerIds = [...catalog.entries.entries()]
    .filter(([, entry]) => entry.target._tag === "BearerConnectionTarget")
    .map(([environmentId]) => String(environmentId));
  const orbitIds = new Set((orbit ?? []).map((entry) => entry.environmentId));
  refusalWatch.watch(bearerIds.filter((environmentId) => orbitIds.has(environmentId)));
  const plan = planEnvironmentProvider({
    provider,
    saved,
    orbit,
    state,
    lacksAccess,
    heldInstanceIds: heldOrbitInstanceIds(),
    renew: readSessionRenewals({ environmentIds: bearerIds, readConnection, readSession, now }),
    knownInstanceServers: rememberedCloneEnvironmentIds(),
    now,
  });
  const savedIds = new Set(saved.map((entry) => entry.environmentId));

  const setEnabled = (environmentId: string, enabled: boolean) =>
    runAtomCommand(
      appAtomRegistry,
      environmentCatalog.setEnabled,
      { environmentId: environmentId as EnvironmentId, enabled },
      { reportFailure: false },
    );
  for (const environmentId of plan.disable) await setEnabled(environmentId, false);
  for (const environmentId of plan.enable) await setEnabled(environmentId, true);

  saveReconciledState(plan.state);
  for (const gone of plan.remove) {
    await removeGoneInstanceServer(gone.environmentId, gone.instanceId);
  }
  // Conn: every renewal of this sync, one after another, without holding up the profile sync.
  const renew = new Set(plan.renew);
  renewInOrder(
    client,
    (orbit ?? []).filter((entry) => renew.has(entry.environmentId)),
  );
  // One other server per run: pairing waits for a Gateway Operation, and the rest of the sync
  // waits too.
  const environmentId = plan.pair.find((id) => !renew.has(id) && !pairings.has(id));
  const environment = orbit?.find((entry) => entry.environmentId === environmentId);
  if (environment) {
    await pairOne(client, environment, savedIds.has(environment.environmentId) ? "access" : "new");
  }
  return orbit;
}
