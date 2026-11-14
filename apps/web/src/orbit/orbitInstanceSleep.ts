import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  createOrbitInstanceWaker,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitInstanceWakeOutcome,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { refreshOrbitThreadIndexHeld } from "./orbitThreadIndex";

/**
 * Conn: asleep Orbit Instances. An Instance Orbit lists as `stopped` and that no window shows is
 * parked: Conn does not connect to it (a connect to a frozen container hangs and wakes nothing),
 * and its rows read "Stopped". A window that shows one of its threads or drafts uses it: Conn asks
 * Orbit to wake it, then connects. Lists, badges and background syncs never wake an Instance.
 */

/** An older Gateway without the wake route is asked again after this long. */
const UNSUPPORTED_RECHECK_MS = 60 * 60_000;
/** A failed wake is not repeated for the same environment before this. */
const FAILED_WAKE_PAUSE_MS = 30_000;
/** A fresh list read for an environment in use that is not connected, at most this often. */
const FRESH_READ_EVERY_MS = 5_000;
/** A listing read while a wake ran may still say `stopped`: trust the wake this long. */
const WOKEN_GRACE_MS = 10_000;
/** A Gateway list older than this is read again before a shown environment is judged. */
const LISTING_STALE_MS = 45_000;
/** A window counts as worked in this long after its last input. */
const USER_ACTIVE_MS = 5 * 60_000;
/** How often a window checks whether a profile sync fed it a list lately. */
const UNFED_POLL_MS = 30_000;
/** The environment provider's storage key (environmentProvider.ts), read here without a cycle. */
const PROVIDER_STORAGE_KEY = "t3code:environment-provider:v1";
/** A view that remounts (a route swap) holds the environment again within this. */
const RELEASE_SETTLE_MS = 1_000;
const UNSUPPORTED_STORAGE_KEY = "t3code:orbit-wake-unsupported-at:v1";

interface OrbitInstanceSleepStore {
  /** Environments whose connection Conn holds off because the Instance is asleep. */
  readonly parked: ReadonlySet<string>;
  /** When an older Gateway answered that it has no wake route; null when it has one. */
  readonly unsupportedAt: number | null;
}

function readUnsupportedAt(): number | null {
  try {
    const raw = Number(window.localStorage.getItem(UNSUPPORTED_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

function rememberUnsupported(at: number): void {
  try {
    window.localStorage.setItem(UNSUPPORTED_STORAGE_KEY, String(at));
  } catch {
    // Without storage the memory lasts until the app restarts.
  }
  useOrbitInstanceSleep.setState({ unsupportedAt: at });
}

export const useOrbitInstanceSleep = create<OrbitInstanceSleepStore>(() => ({
  parked: new Set(),
  unsupportedAt: readUnsupportedAt(),
}));

/** Whether Conn may wake Instances: false once an older Gateway said it has no wake route. */
export function orbitWakeSupported(
  unsupportedAt: number | null = useOrbitInstanceSleep.getState().unsupportedAt,
  now: number = Date.now(),
): boolean {
  return unsupportedAt === null || now - unsupportedAt >= UNSUPPORTED_RECHECK_MS;
}

/** True while Conn holds the environment off because its Instance is asleep. */
export function useOrbitEnvironmentParked(environmentId: string | null): boolean {
  return useOrbitInstanceSleep((state) =>
    environmentId === null ? false : state.parked.has(environmentId),
  );
}

interface ListedInstance {
  readonly instanceId: number;
  readonly stopped: boolean;
}

/** The ports the controller drives; the app's registry and Gateway, or fakes in tests. */
export interface OrbitInstanceSleepPorts {
  readonly isSaved: (environmentId: string) => boolean;
  readonly setParked: (environmentId: string, parked: boolean) => Promise<void>;
  readonly retryNow: (environmentId: string) => Promise<void>;
  readonly wake: (
    client: OrbitGatewayClient,
    instanceId: number,
  ) => Promise<OrbitInstanceWakeOutcome>;
  /**
   * True while the user works in this window (recent input, window visible). A shown thread wakes
   * its Instance only then, so a window left open on a thread does not keep the Instance awake.
   */
  readonly userActive: () => boolean;
  /** True while Orbit provides the environments; outside Orbit mode Conn reads no list itself. */
  readonly orbitMode: () => boolean;
  /** The Gateway client of this window, for a window whose list reads come from nowhere else. */
  readonly gatewayClient: () => OrbitGatewayClient | null;
  readonly now: () => number;
  /** Runs `run` after `ms`; tests run it at once. */
  readonly later?: (run: () => void, ms: number) => void;
}

export function createOrbitInstanceSleepController(ports: OrbitInstanceSleepPorts) {
  let client: OrbitGatewayClient | null = null;
  let listed = new Map<string, ListedInstance>();
  let observedAt: number | null = null;
  const inUse = new Map<string, number>();
  const failedAt = new Map<string, number>();
  const wokenAt = new Map<string, number>();
  let freshReadAt: number | null = null;
  const waking = new Set<string>();
  /** The last connection phase each shown environment reported. */
  const phases = new Map<string, EnvironmentConnectionPhase | null>();
  const supported = () =>
    orbitWakeSupported(useOrbitInstanceSleep.getState().unsupportedAt, ports.now());
  const later = ports.later ?? ((run: () => void, ms: number) => void setTimeout(run, ms));
  const currentClient = () => client ?? ports.gatewayClient();

  const parked = () => useOrbitInstanceSleep.getState().parked;
  const setParked = (environmentId: string, hold: boolean): Promise<void> => {
    const current = parked();
    if (current.has(environmentId) === hold) return Promise.resolve();
    const next = new Set(current);
    if (hold) next.add(environmentId);
    else next.delete(environmentId);
    useOrbitInstanceSleep.setState({ parked: next });
    return ports.setParked(environmentId, hold);
  };
  const releaseAll = async (): Promise<void> => {
    for (const environmentId of parked()) await setParked(environmentId, false);
  };
  const isStopped = (environmentId: string): boolean => {
    const item = listed.get(environmentId);
    if (item === undefined || !item.stopped) return false;
    const woken = wokenAt.get(environmentId);
    return woken === undefined || ports.now() - woken >= WOKEN_GRACE_MS;
  };
  /** Records a wake that succeeded; returns the Instance's environments. */
  const markAwake = (instanceId: number): string[] => {
    const environmentIds: string[] = [];
    for (const [environmentId, item] of listed) {
      if (item.instanceId !== instanceId) continue;
      failedAt.delete(environmentId);
      wokenAt.set(environmentId, ports.now());
      listed.set(environmentId, { ...item, stopped: false });
      environmentIds.push(environmentId);
    }
    return environmentIds;
  };
  /**
   * A 404 on the wake means an older Gateway only while Orbit still lists the Instance: the same
   * answer comes for an Instance that is gone. Anything else is a failed wake.
   */
  const confirmUnsupported = async (
    reader: OrbitGatewayClient,
    instanceId: number,
  ): Promise<OrbitInstanceWakeOutcome> => {
    try {
      const orbit = await reader.environments();
      if (orbit.some((environment) => environment.instanceId === instanceId)) {
        rememberUnsupported(ports.now());
        await releaseAll();
        return { kind: "unsupported" };
      }
    } catch {
      // Unknown: not a reason to stop waking every Instance for an hour.
    }
    return { kind: "failed", code: "instance.not_found", message: "Orbit no longer lists it." };
  };

  const wake = async (environmentId: string): Promise<void> => {
    const item = listed.get(environmentId);
    const reader = currentClient();
    if (reader === null || item === undefined || waking.has(environmentId) || !supported()) return;
    const failed = failedAt.get(environmentId);
    if (failed !== undefined && ports.now() - failed < FAILED_WAKE_PAUSE_MS) {
      // No new wake yet, but the user sees today's failure, not a silent view.
      await setParked(environmentId, false);
      return;
    }
    waking.add(environmentId);
    try {
      // Connecting starts now, so the view shows what a slow connect shows today.
      await setParked(environmentId, false);
      let outcome = await ports.wake(reader, item.instanceId);
      if (outcome.kind === "unsupported")
        outcome = await confirmUnsupported(reader, item.instanceId);
      if (outcome.kind === "awake") {
        markAwake(item.instanceId);
        // Nothing may have held it off meanwhile; release it again before the connect.
        await setParked(environmentId, false);
        await ports.retryNow(environmentId);
      } else if (outcome.kind === "failed") {
        // The connection keeps trying as it does today, and shows today's failure.
        failedAt.set(environmentId, ports.now());
        console.warn(`Conn could not wake ${environmentId}: ${outcome.code}: ${outcome.message}`);
      }
    } finally {
      waking.delete(environmentId);
    }
  };

  /**
   * Parks an asleep Instance unless the user works in it now (then it wakes), and lets an awake one
   * connect. A thread left open in an idle window is parked too, so it can stay asleep.
   */
  const settle = async (environmentId: string): Promise<void> => {
    if (!orbitWakeSupported(useOrbitInstanceSleep.getState().unsupportedAt, ports.now())) {
      await setParked(environmentId, false);
      return;
    }
    if (!isStopped(environmentId)) {
      await setParked(environmentId, false);
      return;
    }
    if (waking.has(environmentId)) return;
    if ((inUse.get(environmentId) ?? 0) > 0 && ports.userActive()) {
      // A list read must not wait for the wake.
      void wake(environmentId);
      return;
    }
    // Also before the catalog has loaded: the registry keeps the hold for a later registration.
    await setParked(environmentId, true);
  };

  /** Each Gateway list read: power states of the Instances' servers. Null outside Orbit mode. */
  const observe = async (
    nextClient: OrbitGatewayClient,
    orbit: readonly OrbitGatewayEnvironment[] | null,
  ): Promise<void> => {
    client = nextClient;
    observedAt = ports.now();
    if (orbit === null) {
      listed = new Map();
      await releaseAll();
      return;
    }
    const previous = listed;
    const next = new Map<string, ListedInstance>();
    for (const environment of orbit) {
      if (environment.instanceId === null || environment.status !== "registered") continue;
      next.set(environment.environmentId, {
        instanceId: environment.instanceId,
        stopped: environment.powerState === "stopped",
      });
    }
    listed = next;
    for (const environmentId of parked()) {
      if (!next.has(environmentId)) await setParked(environmentId, false);
    }
    for (const [environmentId, item] of next) {
      const wasStopped = previous.get(environmentId)?.stopped === true;
      const wasParked = parked().has(environmentId);
      await settle(environmentId);
      // Woken elsewhere (a Route visit, another device): connect now, not after the backoff.
      if (wasStopped && !item.stopped && !wasParked && ports.isSaved(environmentId)) {
        await ports.retryNow(environmentId);
      }
    }
  };

  /** Reads the Gateway list now, at most once per FRESH_READ_EVERY_MS for this window. */
  const readFresh = async (): Promise<void> => {
    const reader = currentClient();
    if (reader === null || !ports.orbitMode()) return;
    if (freshReadAt !== null && ports.now() - freshReadAt < FRESH_READ_EVERY_MS) return;
    freshReadAt = ports.now();
    let orbit: readonly OrbitGatewayEnvironment[];
    try {
      orbit = await reader.environments();
    } catch {
      return;
    }
    await observe(reader, orbit);
  };

  /**
   * A window shows a thread or draft of the environment. While the user works in the window and it
   * is not connected: an Instance listed asleep wakes; otherwise the list is read again, since it
   * may be stale or (in a second window) missing.
   */
  const ensureAwake = async (
    environmentId: string,
    phase: EnvironmentConnectionPhase | null,
  ): Promise<void> => {
    phases.set(environmentId, phase);
    if (phase === "connected" || !ports.userActive()) return;
    if (!orbitWakeSupported(useOrbitInstanceSleep.getState().unsupportedAt, ports.now())) return;
    if (isStopped(environmentId)) {
      await wake(environmentId);
      return;
    }
    const stale = observedAt === null || ports.now() - observedAt >= LISTING_STALE_MS;
    if (!stale && !listed.has(environmentId)) return;
    if (!stale && phase !== "reconnecting" && phase !== "error" && phase !== "available") return;
    await readFresh();
    if (isStopped(environmentId) && (inUse.get(environmentId) ?? 0) > 0) await wake(environmentId);
  };

  /** The user acted in this window: wake the asleep Instances it shows. */
  const activity = (): void => {
    if (!supported()) return;
    let unknown = false;
    for (const environmentId of inUse.keys()) {
      if (isStopped(environmentId)) void wake(environmentId);
      else if (phases.get(environmentId) !== "connected") unknown = true;
    }
    // A shown environment that does not connect may sleep since the last list read: read again.
    if (!unknown) return;
    void readFresh().then(() => {
      for (const environmentId of inUse.keys()) {
        if (isStopped(environmentId)) void wake(environmentId);
      }
    });
  };

  /** A window no profile sync feeds (a second window) reads the list itself now and then. */
  const pollIfUnfed = async (): Promise<void> => {
    if (observedAt !== null && ports.now() - observedAt < LISTING_STALE_MS) return;
    await readFresh();
  };

  /** Marks the environment in use until the returned release runs. */
  const hold = (environmentId: string): (() => void) => {
    inUse.set(environmentId, (inUse.get(environmentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (inUse.get(environmentId) ?? 1) - 1;
      if (count > 0) inUse.set(environmentId, count);
      else {
        inUse.delete(environmentId);
        phases.delete(environmentId);
        // A remount holds it again at once; only an environment nobody shows is parked.
        later(() => {
          if (!inUse.has(environmentId)) void settle(environmentId);
        }, RELEASE_SETTLE_MS);
      }
    };
  };

  /** The create runner's wake: shares the in-flight wake and remembers an older Gateway. */
  const wakeForStart = async (
    startClient: OrbitGatewayClient,
    instanceId: number,
  ): Promise<OrbitInstanceWakeOutcome> => {
    if (!orbitWakeSupported(useOrbitInstanceSleep.getState().unsupportedAt, ports.now())) {
      return { kind: "unsupported" };
    }
    let outcome = await ports.wake(startClient, instanceId);
    if (outcome.kind === "unsupported") outcome = await confirmUnsupported(startClient, instanceId);
    if (outcome.kind === "awake") {
      for (const environmentId of markAwake(instanceId)) await setParked(environmentId, false);
    }
    return outcome;
  };

  return { observe, ensureAwake, hold, wakeForStart, activity, pollIfUnfed };
}

const waker = createOrbitInstanceWaker();

/** The last input in this window (focus, pointer, keys). */
let lastInputAt = typeof document !== "undefined" && document.hasFocus() ? Date.now() : 0;

const controller = createOrbitInstanceSleepController({
  isSaved: (environmentId) =>
    appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.has(environmentId as EnvironmentId),
  setParked: async (environmentId, parked) => {
    await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.setParked,
      { environmentId: environmentId as EnvironmentId, parked },
      { reportFailure: false },
    );
    // Conn (C3, flag on only): the Orbit list shows an asleep server from the index.
    await refreshOrbitThreadIndexHeld();
  },
  retryNow: async (environmentId) => {
    await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.retryNow,
      environmentId as EnvironmentId,
      { reportFailure: false },
    );
  },
  wake: (client, instanceId) => waker.wake(client, instanceId),
  userActive: () =>
    document.visibilityState === "visible" && Date.now() - lastInputAt < USER_ACTIVE_MS,
  gatewayClient: () => desktopOrbitGatewayClientOrNull(),
  orbitMode: () => isOrbitProvider(),
  now: Date.now,
});

export const observeOrbitInstancePower = controller.observe;
export const ensureOrbitEnvironmentAwake = controller.ensureAwake;
export const holdOrbitEnvironmentInUse = controller.hold;
export const wakeOrbitInstanceForStart = controller.wakeForStart;

/** Conn: the renderer's own Gateway client; set by the profile sync module, null outside Orbit. */
let desktopClientFactory: (() => OrbitGatewayClient | null) | null = null;
function desktopOrbitGatewayClientOrNull(): OrbitGatewayClient | null {
  return desktopClientFactory?.() ?? null;
}
export function registerOrbitSleepClient(factory: () => OrbitGatewayClient | null): void {
  desktopClientFactory = factory;
}

/** Whether a window event is work in the window; a cursor passing over an inactive one is not. */
export function countsAsWork(type: string, focused: boolean): boolean {
  return focused || (type !== "pointermove" && type !== "wheel");
}

let windowWatched = false;
/** Notes user input in this window, and lets a window no profile sync feeds read the list. */
function watchWindow(): void {
  if (windowWatched || typeof window === "undefined" || typeof document === "undefined") return;
  windowWatched = true;
  let lastSignal = 0;
  const onInput = (event: Event) => {
    if (!countsAsWork(event.type, document.hasFocus())) return;
    lastInputAt = Date.now();
    // Input comes in bursts: tell the controller at most every 2 s.
    if (lastInputAt - lastSignal < 2_000) return;
    lastSignal = lastInputAt;
    controller.activity();
  };
  for (const name of ["focus", "pointerdown", "pointermove", "keydown", "wheel"] as const) {
    window.addEventListener(name, onInput, { capture: true, passive: true });
  }
  setInterval(() => {
    if (isOrbitProvider()) void controller.pollIfUnfed();
  }, UNFED_POLL_MS);
}

// Input before the first thread view mounts counts too (a click that opens the first thread).
watchWindow();

function isOrbitProvider(): boolean {
  try {
    return window.localStorage.getItem(PROVIDER_STORAGE_KEY) === JSON.stringify("orbit");
  } catch {
    return false;
  }
}

/**
 * Conn: the window shows a thread or draft of this environment, so it is in use. While the user
 * works in the window, an asleep Orbit Instance is woken and then connected. Mount it only where the
 * user works in the environment, never in a background view, list or badge.
 */
export function useOrbitEnvironmentInUse(
  environmentId: string | null,
  phase: EnvironmentConnectionPhase | null,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the shown environment as in use with the sleep controller while mounted
  useEffect(() => {
    if (environmentId === null) return;
    return holdOrbitEnvironmentInUse(environmentId);
  }, [environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks Orbit to wake the shown environment's Instance when its connection is not up
  useEffect(() => {
    if (environmentId === null) return;
    void ensureOrbitEnvironmentAwake(environmentId, phase);
  }, [environmentId, phase]);
}
