import {
  createCredentialRefusalWatch,
  createOrbitProfileLive,
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  forgetOrbitEnvironment,
  forgetPairingRevoked,
  isFinalPairingError,
  isPairingRevokedError,
  parseEnvironmentProvider,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  recordAccessPairing,
  recordPaired,
  recordPairingAttempt,
  recordPairingRefused,
  recordPairingRevoked,
  readSessionRenewals,
  recordRenewal,
  type EnvironmentProvider,
  type OrbitEnvironmentState,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
  type OrbitGatewayProfile,
  type OrbitGatewayWorkspace,
  type ProfileBinding,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairingUrl } from "../../connection/onboarding";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession, readEnvironmentLacksScope } from "../../state/session";
import { orbitGatewayClient as client, orbitGatewayTransport } from "./orbitGatewayClient";
import { runOrbitAppearance } from "./orbitProfileSync";
import { heldOrbitInstanceIds, orbitThreadStartStore } from "./orbitThreadStartStore";
import { addProjectRefToProfileWorkspace } from "./orbitWorkspaceRef";

/**
 * The phone's view of the Orbit Gateway: Node, profile, workspaces and T3 servers. The phone edits
 * workspaces only to add a started thread's clone project (keepProjectInOrbitWorkspace).
 * The appearance syncs both ways (orbitProfileSync). In Orbit mode it pairs the Gateway's servers
 * and switches off environments added by hand (see planEnvironmentProvider).
 */

export interface OrbitGatewayState {
  /** Where this device's environments come from; Orbit calls the Gateway only in `orbit`. */
  readonly provider: EnvironmentProvider;
  readonly providerLoaded: boolean;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly node: OrbitGatewayNode | null;
  readonly profiles: readonly OrbitGatewayProfile[];
  readonly environments: readonly OrbitGatewayEnvironment[];
  readonly workspaces: readonly OrbitGatewayWorkspace[];
  readonly error: string | null;
  /** The workspace the thread list is scoped to on this device, or null for all projects. */
  readonly selectedWorkspaceId: string | null;
  /** Conn: servers whose pairing Orbit revoked for this phone; only Connect pairs them again. */
  readonly revokedEnvironmentIds: readonly string[];
}

const PROVIDER_STORAGE_KEY = "t3code.environment-provider.v1";

let environmentState: OrbitEnvironmentState = EMPTY_ORBIT_ENVIRONMENT_STATE;

let state: OrbitGatewayState = {
  provider: "default",
  providerLoaded: false,
  phase: "idle",
  node: null,
  profiles: [],
  environments: [],
  workspaces: [],
  error: null,
  selectedWorkspaceId: null,
  revokedEnvironmentIds: [],
};
const listeners = new Set<() => void>();

function set(patch: Partial<OrbitGatewayState>): void {
  state = { ...state, ...patch };
  if (
    state.selectedWorkspaceId !== null &&
    !state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)
  ) {
    state = { ...state, selectedWorkspaceId: null };
  }
  for (const listener of listeners) listener();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function saveProvider(): Promise<void> {
  await SecureStore.setItemAsync(
    PROVIDER_STORAGE_KEY,
    JSON.stringify({ provider: state.provider, environments: environmentState }),
  );
}

async function loadProvider(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(PROVIDER_STORAGE_KEY);
    const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    environmentState = parseOrbitEnvironmentState(parsed.environments);
    set({
      provider: parseEnvironmentProvider(parsed.provider),
      providerLoaded: true,
      revokedEnvironmentIds: Object.keys(environmentState.revokedAt ?? {}),
    });
  } catch {
    set({ providerLoaded: true });
  }
}

/** Conn: clones the user asked to connect in Settings; refreshes retry them in this session. */
const requestedEnvironmentIds = new Set<string>();
const pairings = new Map<string, Promise<boolean>>();

async function updateEnvironmentState(
  change: (current: OrbitEnvironmentState) => OrbitEnvironmentState,
): Promise<void> {
  const previous = environmentState;
  environmentState = change(environmentState);
  if (environmentState.revokedAt !== previous.revokedAt) {
    set({ revokedEnvironmentIds: Object.keys(environmentState.revokedAt ?? {}) });
  }
  await saveProvider();
}

/**
 * Conn: why this phone pairs a server. `new`: not saved yet. `access`: saved, but its session
 * cannot manage access. `renew`: saved, and its session ends soon or has ended. `connect`: the
 * user asked for it (the only kind that pairs a server Orbit revoked again).
 */
type PairingKind = "new" | "access" | "renew" | "connect";

/**
 * Conn: pairs this device with one Orbit server and records the attempt and its result. Resolves
 * true when the server is saved. A second call while one runs joins it.
 */
function pairOne(
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  kind: PairingKind,
): Promise<boolean> {
  const { environmentId } = environment;
  const running = pairings.get(environmentId);
  if (running) return running;
  const pairing = attemptPairing(environment, kind).finally(() => pairings.delete(environmentId));
  pairings.set(environmentId, pairing);
  return pairing;
}

async function attemptPairing(
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  kind: PairingKind,
): Promise<boolean> {
  const { environmentId } = environment;
  const now = Date.now();
  try {
    // Saved before the attempt, so a restart during the pairing still backs off.
    await updateEnvironmentState((current) => {
      switch (kind) {
        case "new":
          return recordPairingAttempt(current, environmentId, now);
        case "access":
          return recordAccessPairing(current, environmentId, now);
        case "renew":
          return recordRenewal(current, environmentId, now);
        case "connect":
          // Backs off like a new server, so a failed Connect is not retried on every refresh.
          return recordPairingAttempt(
            forgetPairingRevoked(current, environmentId),
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
      connectPairingUrl,
      { pairingUrl: pairing.pairingUrl },
      { reportFailure: false },
    );
    if (result._tag !== "Success") return false;
    requestedEnvironmentIds.delete(environmentId);
    await updateEnvironmentState((current) => recordPaired(current, environmentId));
    return true;
  } catch (error) {
    // Revoked in Orbit: never again on its own. Unreachable: a later refresh. Refused: after the
    // server registers again.
    if (isPairingRevokedError(error)) {
      await updateEnvironmentState((current) =>
        recordPairingRevoked(current, environmentId, Date.now()),
      ).catch(() => {});
    } else if (isFinalPairingError(error)) {
      await updateEnvironmentState((current) => recordPairingRefused(current, environment)).catch(
        () => {},
      );
    }
    return false;
  }
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

/**
 * Conn: watches each saved Orbit server's connection. A refused credential arrives seconds after
 * the refresh that the app's return to the front started, so that refresh cannot see it; the watch
 * runs one more refresh as soon as the server refuses. The planner's backoff keeps it to one
 * renewal.
 */
const refusalWatch = createCredentialRefusalWatch({
  subscribe: (environmentId, listener) =>
    appAtomRegistry.subscribe(
      environmentCatalog.stateAtom(environmentId as EnvironmentId),
      (result) => listener(Option.getOrNull(AsyncResult.value(result))),
    ),
  onRefused: () => {
    if (state.provider !== "orbit") return;
    // A running refresh may have read the state before the refusal: run one after it.
    void (refreshing ?? Promise.resolve()).then(() => refreshOrbitGateway());
  },
});

/** Conn: a thread start paired with its clone's server, which Orbit provides like any other. */
export async function recordOrbitThreadStartPaired(environmentId: string): Promise<void> {
  // The server is saved already; a lost record only means a later sync re-checks it.
  await updateEnvironmentState((current) => recordPaired(current, environmentId)).catch(() => {});
}

/**
 * Conn: the Connect button for a clone in Settings › Orbit › Servers. Pairs it now, and lets a
 * later refresh retry it if this attempt fails.
 */
export function connectOrbitEnvironment(
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
): Promise<boolean> {
  requestedEnvironmentIds.add(environment.environmentId);
  return pairOne(environment, "connect");
}

/** Switches the saved environments to match the provider, pairing Orbit servers as needed. */
async function reconcileEnvironments(
  orbit: readonly OrbitGatewayEnvironment[] | null,
): Promise<void> {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return;
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
    provider: state.provider,
    saved,
    orbit,
    state: environmentState,
    lacksAccess,
    // Conn: a thread start pairs its own clone; the sync must not pair it a second time.
    heldInstanceIds: heldOrbitInstanceIds(),
    requestedEnvironmentIds: [...requestedEnvironmentIds],
    renew: readSessionRenewals({ environmentIds: bearerIds, readConnection, readSession, now }),
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
  // Pairing records come from the current state, so a Connect during this refresh keeps its own.
  await updateEnvironmentState((current) =>
    plan.state.pairedByOrbit.reduce(recordPaired, {
      ...current,
      disabledByOrbit: plan.state.disabledByOrbit,
      instanceServers: plan.state.instanceServers ?? {},
      missingFromGateway: plan.state.missingFromGateway ?? {},
    }),
  );
  // Conn: the server of an Instance the Gateway's lists left out long enough is gone; Orbit may give
  // its address to a new Instance. Removed from this device as the desktop's Orbit panel does.
  for (const { environmentId } of plan.remove) {
    await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.remove,
      environmentId as EnvironmentId,
      { reportFailure: false },
    );
    await updateEnvironmentState((current) => forgetOrbitEnvironment(current, environmentId));
  }
  // Conn: until the saved thread starts load, the sync cannot tell which clones they hold.
  if (!orbitThreadStartStore.loaded()) return;
  // Conn: a pairing follows a Gateway Operation for up to a minute. It runs after the refresh, so
  // the lists and a later refresh never wait for it; a refresh during a run starts no second run.
  // A refresh during a run plans again once the run ends, so a refusal seen meanwhile still renews.
  if (pairingRun) {
    pairingAgain = true;
    return;
  }
  const provider = state.provider;
  pairingRun = runPairings(orbit ?? [], plan.renew, plan.pair, savedIds).finally(() => {
    pairingRun = null;
    // A switch of provider during the run re-applies the new one; a refresh during it plans again.
    if (state.provider !== provider || (pairingAgain && state.provider === "orbit")) {
      pairingAgain = false;
      void refreshOrbitGateway();
    }
    pairingAgain = false;
  });
}

let pairingRun: Promise<void> | null = null;
let pairingAgain = false;

/** Conn: the pairings one refresh planned, run after it. */
async function runPairings(
  orbit: readonly OrbitGatewayEnvironment[],
  renewIds: readonly string[],
  pairIds: readonly string[],
  savedIds: ReadonlySet<string>,
): Promise<void> {
  // Every renewal of this refresh, one after another, so all servers work again after one app
  // open without a burst of Gateway Operations.
  const renew = new Set(renewIds);
  for (const entry of orbit) {
    // A switch to Default mode during the run stops it before the next pairing.
    if (state.provider !== "orbit") return;
    if (renew.has(entry.environmentId) && !pairings.has(entry.environmentId)) {
      await pairOne(entry, "renew");
    }
  }
  // One other server per refresh.
  const environmentId = pairIds.find((id) => !renew.has(id) && !pairings.has(id));
  const environment = orbit.find((entry) => entry.environmentId === environmentId);
  if (environment && state.provider === "orbit") {
    await pairOne(environment, savedIds.has(environment.environmentId) ? "access" : "new");
  }
}

let refreshing: Promise<void> | null = null;
/** The profile version whose workspaces this phone shows, so a profile read skips an equal one. */
let appliedWorkspaces: { readonly profileId: number; readonly version: number } | null = null;
/**
 * The two sources of the shown error: the lists of a refresh, and the profile read,
 * which retries on its own. Each clears only its own failure.
 */
let listError: string | null = null;
let profileReadError: string | null = null;

function profileReadFailed(error: unknown): void {
  profileReadError = message(error);
  set({
    error: listError ?? profileReadError,
    phase: state.phase === "ready" ? "error" : state.phase,
  });
}

function profileReadSucceeded(): void {
  if (profileReadError === null) return;
  profileReadError = null;
  set({
    error: listError,
    phase: state.phase === "error" && listError === null ? "ready" : state.phase,
  });
}

type WorkspaceSettings = {
  readonly profileId: number;
  readonly version: number;
  readonly workspaces: readonly OrbitGatewayWorkspace[];
};
/** A write that answered before the first read knew the binding; that read decides on it. */
let pendingWrite: WorkspaceSettings | null = null;

/**
 * Shows a profile's workspaces in Orbit mode, for the profile the phone is bound to, and never an
 * older version of them (a read and a write can answer in either order).
 */
function applyWorkspaces(settings: WorkspaceSettings): void {
  if (state.provider !== "orbit") return;
  if (state.node === null) {
    if (pendingWrite === null || pendingWrite.version < settings.version) pendingWrite = settings;
    return;
  }
  const pending = pendingWrite;
  pendingWrite = null;
  const bound = state.node.profile?.id;
  const best =
    pending !== null && pending.profileId === bound && pending.version > settings.version
      ? pending
      : settings;
  if (best.profileId !== bound) return;
  if (appliedWorkspaces?.profileId === best.profileId && appliedWorkspaces.version > best.version) {
    return;
  }
  appliedWorkspaces = { profileId: best.profileId, version: best.version };
  set({ workspaces: best.workspaces });
}

/**
 * One authoritative profile read for the shared subscription: the Node, the workspaces when the
 * version moved, and the appearance. Applies nothing once `isCurrent()` is false.
 */
async function refreshOrbitProfile(
  isCurrent: () => boolean,
  observe: (channel: string | null) => void,
): Promise<ProfileBinding | null> {
  if (state.provider !== "orbit") return null;
  const node = await client.me();
  if (!isCurrent()) return null;
  observe(node.profileChannel ?? null);
  const profile = node.profile;
  if (profile === null) {
    appliedWorkspaces = null;
    set({ node, workspaces: [] });
    profileReadSucceeded();
    return null;
  }
  if (
    appliedWorkspaces?.profileId !== profile.id ||
    appliedWorkspaces.version < profile.settingsVersion
  ) {
    const settings = await client.settings(profile.id);
    if (!isCurrent()) return null;
    set({ node });
    applyWorkspaces(settings);
  } else {
    set({ node });
    if (pendingWrite !== null) applyWorkspaces(pendingWrite);
  }
  if (!(await runOrbitAppearance(node, isCurrent))) {
    throw new Error("The phone's preferences are not loaded yet.");
  }
  if (!isCurrent()) return null;
  profileReadSucceeded();
  return {
    profileId: profile.id,
    version: profile.settingsVersion,
    channel: node.profileChannel ?? null,
  };
}

/**
 * Follows the bound profile while the app is in front: `conn.profile.updated` notices, a read on
 * foreground and reconnect, and the shared low-frequency check against dropped notices.
 */
const profileLive = createOrbitProfileLive({
  transport: orbitGatewayTransport,
  scope: () => (state.provider === "orbit" ? "orbit" : null),
  refresh: refreshOrbitProfile,
  // Only a current read reports here; the refresh shows it as the Gateway's error.
  onError: profileReadFailed,
});

/**
 * Applies the environment provider. In Orbit mode it also reads the node, profiles, servers, and
 * the bound profile's workspaces; Default mode makes no Gateway call.
 */
export function refreshOrbitGateway(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (!state.providerLoaded) await loadProvider();
      if (state.provider === "default") {
        appliedWorkspaces = null;
        pendingWrite = null;
        listError = null;
        profileReadError = null;
        set({ phase: "idle", node: null, environments: [], workspaces: [], error: null });
        // Closes the profile subscription at once: its scope is gone.
        void profileLive.reconcile();
        await reconcileEnvironments(null);
        return;
      }
      listError = null;
      set({ phase: "loading", error: profileReadError });
      // The Node, workspaces and appearance come from the profile read, which runs one at a time
      // with the notices' reads, so an older answer never replaces a newer one.
      const [profiles, environments] = await Promise.all([
        client.profiles(),
        client.environments(),
        profileLive.reconcile(),
      ]);
      set({
        phase: profileReadError === null ? "ready" : "error",
        error: profileReadError,
        profiles,
        environments,
      });
      await reconcileEnvironments(environments);
    } catch (error) {
      listError = message(error);
      set({ phase: "error", error: listError });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Chooses where this device's environments come from and applies it at once. */
export async function setEnvironmentProvider(provider: EnvironmentProvider): Promise<void> {
  if (refreshing) await refreshing;
  // Conn: a pairing in flight saves its server; let it end before the switch reconciles.
  if (pairingRun) await pairingRun;
  set({ provider });
  await saveProvider();
  await refreshOrbitGateway();
}

/** Binds this device to a profile, creating it first when `profile` is a new name. */
export async function chooseOrbitProfile(
  profile: { readonly id: number } | { readonly name: string },
): Promise<void> {
  try {
    const id = "id" in profile ? profile.id : (await client.createProfile(profile.name)).id;
    // The old binding's channel and any read in flight must not apply to the new one.
    profileLive.invalidate();
    await client.bindProfile(id);
    // A read that started while the bind was pending still saw the old binding.
    profileLive.invalidate();
  } catch (error) {
    // The caller shows the failed bind; it is not a list failure for later reads to bring back.
    set({ error: message(error) });
    void profileLive.reconcile();
    throw error;
  }
  // A profile read that starts after the bind, not one a running refresh already holds.
  await Promise.all([profileLive.reconcile(), refreshOrbitGateway()]);
}

/**
 * Syncs the appearance with the profile now, as after a theme change on this phone. It runs as a
 * profile read, so the provider, the binding and the app's lifecycle scope it like a notice.
 */
export function syncOrbitAppearanceNow(): Promise<void> {
  return profileLive.reconcile();
}

/**
 * Conn: adds a started thread's clone project to the profile workspace selected at Start, so the
 * workspace filter shows the thread. Failures leave the workspace as it was.
 */
export async function keepProjectInOrbitWorkspace(
  workspaceId: string | null,
  projectRef: string,
): Promise<void> {
  if (workspaceId === null) return;
  try {
    // A start resumed at launch can send before the first refresh read the profile; a refresh
    // could wait on another server's pairing, so read only the Node.
    const node = state.node ?? (await client.me());
    const profileId = node.profile?.id;
    if (profileId === undefined) return;
    const saved = await addProjectRefToProfileWorkspace(client, profileId, workspaceId, projectRef);
    if (saved) applyWorkspaces(saved);
  } catch {
    // The thread is sent; a later Start or the desktop can still add the ref.
  }
}

export function selectOrbitWorkspace(workspaceId: string | null): void {
  set({ selectedWorkspaceId: workspaceId });
}

/** The selected workspace's projects as environment-scoped refs, or null without a selection. */
export function selectedWorkspaceProjectRefs(
  current: OrbitGatewayState,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }> | null {
  const workspace = current.workspaces.find((entry) => entry.id === current.selectedWorkspaceId);
  if (!workspace) return null;
  return (workspace.projectRefs ?? []).flatMap((ref) => {
    const at = ref.indexOf(":");
    return at > 0
      ? [
          {
            environmentId: ref.slice(0, at) as EnvironmentId,
            projectId: ref.slice(at + 1) as ProjectId,
          },
        ]
      : [];
  });
}

export function subscribeOrbitGateway(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function orbitGatewayState(): OrbitGatewayState {
  return state;
}

let started = false;

/**
 * Starts the app-wide Gateway state once: the first refresh, the profile subscription while the
 * app is in front, and the foreground/background lifecycle.
 */
export function startOrbitGateway(): void {
  if (started) return;
  started = true;
  // Resumed first, so the refresh's profile read (after the provider loads) subscribes.
  if (AppState.currentState === "active") void profileLive.resume();
  void refreshOrbitGateway();
  AppState.addEventListener("change", (next) => {
    if (next === "active") {
      void profileLive.resume();
      void refreshOrbitGateway();
    } else if (next === "background") {
      profileLive.pause();
    }
  });
}

/**
 * The Gateway state. The first use loads it, and it reloads whenever the app comes to the front.
 * Profile changes from other devices arrive through the shared subscription while the app is in
 * front; in the background the socket and its check stop.
 */
export function useOrbitGateway(): OrbitGatewayState {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the app-wide AppState listener and the profile subscription once
  useEffect(startOrbitGateway, []);
  return useSyncExternalStore(subscribeOrbitGateway, () => state);
}
