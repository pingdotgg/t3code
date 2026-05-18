// Reconciles desktop-managed secondary local environments (today: the
// WSL backend when the user enables it) with what's currently in the
// saved-environment runtime registry.
//
// Why this lives alongside the saved-env machinery rather than inside
// `apps/web/src/environments/primary/`:
//   - It needs the same per-env bearer-token transport as remote
//     saved envs. The primary path is cookie-based and same-origin;
//     a WSL backend at a different localhost port is cross-origin
//     for cookies but fine for `Authorization: Bearer ...`.
//   - Reusing `ensureSavedEnvironmentConnection` plus the existing
//     saved-env stores means the env switcher, sidebar lists, project
//     env-id routing, and connection lifecycle pick these up without
//     a parallel set of UI surfaces.
//   - The persistence layer for saved envs filters records carrying
//     `desktopLocal`, so toggling the WSL backend off or switching
//     distros doesn't leave stale entries in the user's settings file
//     when the desktop bootstrap stops reporting them.
//
// Reconciliation is driven by `getLocalEnvironmentBootstraps()` from
// the desktop bridge. The primary entry (id === "primary") stays
// owned by the primary/ runtime; everything else flows through here.
// On each call, the reconciler:
//   1. Drops registry entries whose desktopLocal.instanceId no longer
//      appears in the bootstraps list.
//   2. Bootstraps + connects new entries that do appear.
// It's safe to call multiple times — pending work is deduped by
// `pendingByInstanceId` and entries already wired up are skipped.

import { create } from "zustand";

import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type AuthSessionRole,
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
} from "@t3tools/contracts";

import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
} from "../remote/api";
import {
  ensureSavedEnvironmentConnection,
  removeSavedEnvironmentByInstance,
} from "../runtime/service";
import {
  getSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
  useSavedEnvironmentRegistryStore,
  writeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
} from "../runtime/catalog";

interface PendingRegistration {
  readonly promise: Promise<SavedEnvironmentRecord | null>;
}

const pendingByInstanceId = new Map<string, PendingRegistration>();
let pendingReconcileRun: Promise<void> | null = null;

// Backoff schedule for the auto-retry loop. WSL cold boot routinely
// takes 30-60 seconds (distro spin-up + node-pty preflight + node
// startup + migrations), and the backend's desktop-bootstrap grant
// has a 5-minute TTL after seeding. This schedule comfortably covers
// the cold-boot window while leaving headroom inside the TTL.
const AUTO_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 45_000, 60_000, 60_000] as const;
let autoRetryHandle: ReturnType<typeof setTimeout> | null = null;
let autoRetryAttempt = 0;

// Latched once we've confirmed the user has no WSL backend configured
// on this host. The auto-retry loop polls getLocalEnvironmentBootstraps
// every few seconds for up to ~4 minutes (the desktop-bootstrap TTL
// window); on machines where the user will never enable WSL that's
// just wasted IPC. setWslBackendEnabled IPC handlers in the settings
// page already call reconcile with resetBudget: true, so flipping the
// switch on later resumes the loop. We default to false (keep
// retrying) so any pre-existing WSL setup still gets retried during
// cold boot.
let knownNoSecondariesConfigured = false;

export interface LocalSecondaryReconcileBootstrapSnapshot {
  readonly id: string;
  readonly label: string;
  readonly hasToken: boolean;
  readonly httpBaseUrl: string;
}

export interface LocalSecondaryReconcileError {
  readonly message: string;
  readonly at: string;
}

export interface LocalSecondaryReconcileState {
  // Bootstraps the renderer most recently learned about from the
  // desktop pool. Reflects whatever the next register attempt will
  // try to bring up.
  readonly bootstrapsSeen: ReadonlyArray<LocalSecondaryReconcileBootstrapSnapshot>;
  // Instance ids that have a register call in flight right now.
  readonly pendingInstanceIds: ReadonlyArray<string>;
  // Per-instance error trace from the most recent register attempt
  // that failed. Cleared when that instance registers successfully.
  readonly registrationErrors: Readonly<Record<string, LocalSecondaryReconcileError>>;
  // True once the auto-retry budget has run out without all
  // secondaries landing. The sidebar uses this to switch from
  // "Connecting" to "Couldn't connect, retry?".
  readonly budgetExhausted: boolean;
  readonly lastReconcileAt: string | null;
  readonly attempts: number;
}

export const useLocalSecondaryReconcileStore = create<LocalSecondaryReconcileState>()(() => ({
  bootstrapsSeen: [],
  pendingInstanceIds: [],
  registrationErrors: {},
  budgetExhausted: false,
  lastReconcileAt: null,
  attempts: 0,
}));

function patchReconcileState(patch: Partial<LocalSecondaryReconcileState>): void {
  useLocalSecondaryReconcileStore.setState((state) => ({ ...state, ...patch }));
}

function addPending(instanceId: string): void {
  useLocalSecondaryReconcileStore.setState((state) => {
    if (state.pendingInstanceIds.includes(instanceId)) return state;
    return { ...state, pendingInstanceIds: [...state.pendingInstanceIds, instanceId] };
  });
}

function removePending(instanceId: string): void {
  useLocalSecondaryReconcileStore.setState((state) => {
    if (!state.pendingInstanceIds.includes(instanceId)) return state;
    return {
      ...state,
      pendingInstanceIds: state.pendingInstanceIds.filter((id) => id !== instanceId),
    };
  });
}

function setRegistrationError(instanceId: string, error: LocalSecondaryReconcileError): void {
  useLocalSecondaryReconcileStore.setState((state) => ({
    ...state,
    registrationErrors: { ...state.registrationErrors, [instanceId]: error },
  }));
}

function clearRegistrationError(instanceId: string): void {
  useLocalSecondaryReconcileStore.setState((state) => {
    if (!(instanceId in state.registrationErrors)) return state;
    const next = { ...state.registrationErrors };
    delete next[instanceId];
    return { ...state, registrationErrors: next };
  });
}

// Surface the reconciler's state on `window` for ad-hoc debugging.
// Production renderers don't expose CDP, so this is the only way for
// a user to inspect what the local-secondary reconciler thinks
// happened. Reads straight from the zustand store so it always
// reflects the current state.
function exposeDebugGlobal(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    __t3LocalSecondaryDebug?: {
      getState: () => LocalSecondaryReconcileState;
      retryNow: () => Promise<void>;
    };
  };
  if (w.__t3LocalSecondaryDebug) return;
  w.__t3LocalSecondaryDebug = {
    getState: () => useLocalSecondaryReconcileStore.getState(),
    retryNow: () => reconcileLocalSecondaryEnvironments(),
  };
}

function readBootstraps(): readonly DesktopEnvironmentBootstrap[] {
  // Guard against test environments that import this module under
  // Node (no window) but exercise the service entrypoint that boots
  // the reconciler.
  if (typeof window === "undefined") return [];
  exposeDebugGlobal();
  let list: readonly DesktopEnvironmentBootstrap[] = [];
  try {
    list = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  } catch (error) {
    console.error("[LOCAL_SECONDARY] readBootstraps threw", error);
    return [];
  }
  patchReconcileState({
    bootstrapsSeen: list.map((entry) => ({
      id: entry.id,
      label: entry.label,
      hasToken: Boolean(entry.bootstrapToken),
      httpBaseUrl: entry.httpBaseUrl ?? "",
    })),
    lastReconcileAt: new Date().toISOString(),
    attempts: useLocalSecondaryReconcileStore.getState().attempts + 1,
  });
  return list;
}

function findRecordByInstanceId(instanceId: string): SavedEnvironmentRecord | null {
  const byId = useSavedEnvironmentRegistryStore.getState().byId ?? {};
  for (const record of Object.values(byId)) {
    if (record.desktopLocal?.instanceId === instanceId) {
      return record;
    }
  }
  return null;
}

function isRegisteredForBootstrap(
  bootstrap: DesktopEnvironmentBootstrap,
  record: SavedEnvironmentRecord,
): boolean {
  // The httpBaseUrl is the load-bearing identity field: if the desktop
  // restarts the WSL backend on a new port (e.g. after a port collision)
  // we want to re-register so the renderer points at the new URL.
  return (
    record.desktopLocal?.instanceId === bootstrap.id &&
    record.httpBaseUrl === bootstrap.httpBaseUrl &&
    record.wsBaseUrl === bootstrap.wsBaseUrl
  );
}

async function tryReuseStoredBearer(input: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
}): Promise<{ readonly bearerToken: string; readonly role: AuthSessionRole } | null> {
  // The bearer session token we got from the first bootstrap is
  // persisted in the desktop secret store keyed by environmentId, and
  // it stays valid for 30 days. Check the backend's view of the bearer
  // before re-bootstrapping: if it's still good we skip the bootstrap
  // exchange entirely (the bootstrap path is also safe to repeat now
  // that the desktop-bootstrap grant is reusable, but reusing the
  // existing bearer keeps the auth log cleaner and avoids spending a
  // round-trip on every page reload).
  const stored = await readSavedEnvironmentBearerToken(input.environmentId);
  if (!stored) return null;
  try {
    const session = await fetchRemoteSessionState({
      httpBaseUrl: input.httpBaseUrl,
      bearerToken: stored,
    });
    if (!session.authenticated || !session.role) return null;
    return { bearerToken: stored, role: session.role };
  } catch {
    return null;
  }
}

async function registerSecondaryLocalEnvironment(
  bootstrap: DesktopEnvironmentBootstrap,
): Promise<SavedEnvironmentRecord | null> {
  if (!bootstrap.httpBaseUrl || !bootstrap.wsBaseUrl) {
    return null;
  }
  const credential = bootstrap.bootstrapToken;
  if (!credential) {
    // No way to authenticate without the shared bootstrap token. The
    // desktop side fills this in for every instance with a config, so
    // a missing token means we're racing the WSL backend's first
    // start; the next reconcile pass will pick it up.
    return null;
  }

  const descriptor = await fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: bootstrap.httpBaseUrl,
  });
  const environmentId = descriptor.environmentId;

  // Drop any stale record pointing at a different bootstrap (URL
  // change, instance-id rename) before writing the new one. We can't
  // just upsert because the old record may have used a different
  // environmentId.
  const stale = findRecordByInstanceId(bootstrap.id);
  if (stale && stale.environmentId !== environmentId) {
    await removeSavedEnvironmentByInstance(stale.environmentId);
  }

  let bearerToken: string;
  let role: AuthSessionRole;
  const reused = await tryReuseStoredBearer({
    environmentId,
    httpBaseUrl: bootstrap.httpBaseUrl,
  });
  if (reused) {
    bearerToken = reused.bearerToken;
    role = reused.role;
  } else {
    const bearerSession = await bootstrapRemoteBearerSession({
      httpBaseUrl: bootstrap.httpBaseUrl,
      credential,
    });
    bearerToken = bearerSession.sessionToken;
    role = bearerSession.role;
    // Only the fresh-bootstrap path needs to write the token: the
    // reuse path already had it in the secret store.
    await writeSavedEnvironmentBearerToken(environmentId, bearerToken);
  }

  const existing = getSavedEnvironmentRecord(environmentId);
  const record: SavedEnvironmentRecord = {
    environmentId,
    label: bootstrap.label,
    wsBaseUrl: bootstrap.wsBaseUrl,
    httpBaseUrl: bootstrap.httpBaseUrl,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
    desktopLocal: { instanceId: bootstrap.id },
  };

  // Order is load-bearing: the bearer must be in the secret store
  // before we upsert. The zustand subscriber on the registry fires a
  // saved-env sync as soon as upsert lands, and that path reads the
  // bearer back out via readSavedEnvironmentBearerToken; without the
  // earlier write the sync would race ahead, find no bearer, and flip
  // the runtime state to "requires-auth" before the explicit
  // ensureSavedEnvironmentConnection call below runs.
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  await ensureSavedEnvironmentConnection(record, {
    bearerToken,
    role,
  });
  return record;
}

async function reconcileOnce(): Promise<void> {
  const bootstraps = readBootstraps();
  const secondaries = bootstraps.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
  const desiredInstanceIds = new Set(secondaries.map((entry) => entry.id));

  // Drop registry entries whose backend instance is gone (user toggled
  // the WSL backend off, switched distros, or the orchestrator
  // unregistered for any other reason). The `?? {}` keeps this safe in
  // test environments that hand back a partially-populated registry
  // state.
  const registry = useSavedEnvironmentRegistryStore.getState().byId ?? {};
  const stale: EnvironmentId[] = [];
  for (const record of Object.values(registry)) {
    const instanceId = record.desktopLocal?.instanceId;
    if (instanceId !== undefined && !desiredInstanceIds.has(instanceId)) {
      stale.push(record.environmentId);
    }
  }
  for (const environmentId of stale) {
    await removeSavedEnvironmentByInstance(environmentId);
  }

  // Bring up entries we don't have yet. Concurrent reconcile calls
  // share a pending promise per instance id so we don't double-register.
  await Promise.all(
    secondaries.map(async (bootstrap) => {
      const existing = findRecordByInstanceId(bootstrap.id);
      if (existing && isRegisteredForBootstrap(bootstrap, existing)) {
        return;
      }

      const pending = pendingByInstanceId.get(bootstrap.id);
      if (pending) {
        await pending.promise.catch(() => undefined);
        return;
      }

      // Hard ceiling per attempt so a hung step (e.g. WebSocket open
      // that never resolves, or an IPC call that doesn't return) can't
      // wedge `pendingReconcileRun` and silence the entire retry loop.
      const attemptTimeoutMs = 25_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(new Error(`Timed out registering ${bootstrap.id} after ${attemptTimeoutMs}ms`)),
          attemptTimeoutMs,
        );
      });
      addPending(bootstrap.id);
      const promise = Promise.race([registerSecondaryLocalEnvironment(bootstrap), timeoutPromise])
        .then((record) => {
          if (record) {
            clearRegistrationError(bootstrap.id);
          }
          return record;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setRegistrationError(bootstrap.id, {
            message,
            at: new Date().toISOString(),
          });
          console.error("[LOCAL_SECONDARY] register failed", bootstrap.id, error);
          return null;
        })
        .finally(() => {
          pendingByInstanceId.delete(bootstrap.id);
          removePending(bootstrap.id);
        });
      pendingByInstanceId.set(bootstrap.id, { promise });
      await promise;
    }),
  );
}

function scheduleAutoRetry(): void {
  if (autoRetryHandle !== null) return;
  // For hosts where the user has no WSL backend configured the retry
  // loop never has work to do, so we'd otherwise IPC every 2-60s
  // forever. setWslBackendEnabled clears this latch (via
  // markSecondariesConfigured) when the user flips WSL on later.
  if (knownNoSecondariesConfigured) return;
  if (autoRetryAttempt >= AUTO_RETRY_DELAYS_MS.length) {
    // Budget exhausted. Surface this through the store so the sidebar
    // can switch from "Connecting..." to "Couldn't connect, retry?".
    patchReconcileState({ budgetExhausted: true });
    return;
  }
  // Note: we deliberately don't short-circuit on an empty bootstraps
  // list past the knownNoSecondariesConfigured check above. The desktop
  // pool only publishes a backend's bootstrap once its first start
  // cycle has produced a config (see
  // desktop.ipc.window.getLocalEnvironmentBootstraps), so an in-flight
  // WSL cold boot looks identical to "no WSL configured" from this
  // side. We have to keep polling until either a secondary actually
  // shows up or the budget runs out.
  const delay = AUTO_RETRY_DELAYS_MS[autoRetryAttempt];
  autoRetryAttempt += 1;
  autoRetryHandle = setTimeout(() => {
    autoRetryHandle = null;
    void runReconcile({ resetBudget: false });
  }, delay);
}

function runReconcile(options: { readonly resetBudget: boolean }): Promise<void> {
  if (pendingReconcileRun) {
    return pendingReconcileRun;
  }
  if (options.resetBudget) {
    // A user-driven reconcile (or the boot path) resets the backoff
    // counter so the auto-retry loop gets a fresh shot. Without this
    // reset, toggling WSL off/on after exhausting the budget wouldn't
    // resume retries. Internal retries pass resetBudget: false so the
    // backoff actually advances each tick.
    autoRetryAttempt = 0;
    if (autoRetryHandle !== null) {
      clearTimeout(autoRetryHandle);
      autoRetryHandle = null;
    }
    patchReconcileState({ budgetExhausted: false });
  }
  const next = reconcileOnce()
    .finally(() => {
      if (pendingReconcileRun === next) {
        pendingReconcileRun = null;
      }
    })
    .then(() => {
      scheduleAutoRetry();
    });
  pendingReconcileRun = next;
  return next;
}

// Public entry point. Idempotent and never throws: internal failures
// get logged and the caller can retry by calling again. Multiple
// concurrent calls share a single underlying reconcile pass. When a
// secondary's registration fails (typical cause: WSL backend still
// cold-booting), an internal backoff loop keeps retrying until either
// the secondary lands in the registry or the desktop-bootstrap TTL
// runs out and we give up.
export function reconcileLocalSecondaryEnvironments(): Promise<void> {
  return runReconcile({ resetBudget: true });
}

// Called by the settings page when the user enables/disables WSL.
// Flips the "no secondaries here" latch so the auto-retry loop wakes
// back up (or stays parked) accordingly. Asynchronously probes
// getWslState at module init so non-WSL hosts park immediately
// instead of burning ~4 minutes of polls before the budget runs out.
export function markSecondariesConfigured(configured: boolean): void {
  knownNoSecondariesConfigured = !configured;
}

if (typeof window !== "undefined") {
  // Best-effort: any failure (no bridge, IPC error, missing field)
  // keeps the default "stay polling" behavior intact. wsl-only mode
  // also counts as "no secondaries": the desktop pool runs WSL as
  // primary and skips the wsl:<distro> secondary registration, so
  // the auto-retry loop has nothing to wait for.
  void (async () => {
    try {
      const state = await window.desktopBridge?.getWslState();
      if (state && (!state.enabled || state.wslOnly)) {
        knownNoSecondariesConfigured = true;
      }
    } catch {
      // ignore — fall through to default polling
    }
  })();
}
