import {
  admitOrbitCompletion,
  followOrbitCompletion,
  markOrbitCompletionRetry,
  newOrbitThreadStart,
  orbitCompletionNeedsAdmission,
  orbitCompletionNeedsFollow,
  orbitCompletionPhase,
  runOrbitThreadStart,
  sendOrbitFirstMessage,
  type OrbitFirstMessagePorts,
  type OrbitGatewayClient,
  type OrbitCompletionPorts,
  type OrbitGatewayProject,
  type OrbitThreadStart,
  type OrbitThreadStartPorts,
  type TakenOrbitReservation,
} from "@t3tools/client-runtime/orbit-gateway";

import { isDraftThreadRoute } from "../threads/thread-route-state";
import type { OrbitThreadStartStore } from "./orbitThreadStartStore";

/** Conn: runs the threads started in an Orbit Project on this phone (FORK.md, "Orbit"). */

export interface MobileOrbitThreadStartPorts {
  readonly store: OrbitThreadStartStore;
  readonly gateway: OrbitGatewayClient;
  /** False once the device leaves Orbit mode: the start pauses until it comes back. */
  readonly orbitMode: () => boolean;
  /** Resolves false when the saved environments did not load in time. */
  readonly catalogReady: () => Promise<boolean>;
  readonly isSaved: (environmentId: string) => boolean;
  readonly reservationPairing?: OrbitThreadStartPorts["reservationPairing"];
  readonly waitForReservationPairing?: OrbitThreadStartPorts["waitForReservationPairing"];
  /** The name checks run while the user typed the first message. */
  readonly nameFits?: OrbitThreadStartPorts["nameFits"];
  readonly connect: OrbitThreadStartPorts["connect"];
  readonly firstMessage: Omit<OrbitFirstMessagePorts, "stopped">;
  /** Adds the clone's project ref to the workspace selected at Start; never throws. */
  readonly keepInWorkspace: (workspaceId: string | null, projectRef: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/**
 * Where Start goes back to, from the Orbit project screen on top of `state`: past Choose project,
 * and past the new-thread draft that opened it, which closes itself on focus when it has no
 * project. The thread opens on send only while that route still shows.
 */
export function orbitStartReturn(
  state:
    | {
        readonly index: number;
        readonly routes: ReadonlyArray<{
          readonly key: string;
          readonly name: string;
          readonly params?: object;
        }>;
      }
    | undefined,
): { readonly back: number; readonly returnRouteKey: string | undefined } {
  if (state === undefined) return { back: 1, returnRouteKey: undefined };
  let back = state.routes[state.index - 1]?.name === "NewTaskProject" ? 2 : 1;
  if (isDraftThreadRoute(state.routes[state.index - back])) back += 1;
  return { back, returnRouteKey: state.routes[state.index - back]?.key };
}

export function beginOrbitThreadStart(
  store: OrbitThreadStartStore,
  input: {
    readonly project: OrbitGatewayProject;
    readonly message: string;
    readonly workspaceId: string | null;
    readonly uuid: () => string;
    readonly now: number;
    /** The clone reserved while the screen was open; the start finalizes it. */
    readonly reservation?: TakenOrbitReservation | null;
    /** The name suffix the screen checked names with while the user typed; else a new one. */
    readonly suffix?: string;
  },
): OrbitThreadStart {
  const start = {
    ...newOrbitThreadStart({
      id: input.uuid(),
      project: input.project,
      message: input.message,
      suffix: input.suffix ?? input.uuid().slice(0, 6),
      threadId: input.uuid(),
      messageId: input.uuid(),
      commandId: input.uuid(),
      now: input.now,
      instanceDomainSuffix: input.project.instanceDomainSuffix ?? null,
      reservation: input.reservation ?? null,
    }),
    workspaceId: input.workspaceId,
  };
  store.update((starts) => [...starts, start]);
  return start;
}

const running = new Set<string>();

/**
 * The state machine saves a step and makes the next call at once; on the phone the save is an
 * async file write. Each call first waits for the write, so a key or Operation id the call
 * depends on is on disk before the Gateway sees it. A failed write stops the step.
 */
function afterSave(store: OrbitThreadStartStore, gateway: OrbitGatewayClient): OrbitGatewayClient {
  const saved =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      await store.flush();
      return call(...args);
    };
  return {
    ...gateway,
    createThreadInstance: saved(gateway.createThreadInstance),
    reservation: saved(gateway.reservation),
    finalizeReservation: saved(gateway.finalizeReservation),
    operation: saved(gateway.operation),
    environments: saved(gateway.environments),
    startPairing: saved(gateway.startPairing),
    // A completion Retry's key is on disk before Orbit sees it, so a restart repeats that key.
    completeInstance: saved(gateway.completeInstance),
    // Not readPairing: the Operation poll before it already waited, and a failed wait there
    // would make Retry mint a second pairing.
  };
}

/**
 * Runs a start from its last saved step, once at a time. Resolves the thread it sent the first
 * message in, or null when the start stopped (its `error` says why) or paused.
 */
export async function runSavedOrbitThreadStart(
  id: string,
  ports: MobileOrbitThreadStartPorts,
): Promise<{ readonly environmentId: string; readonly threadId: string } | null> {
  const { store } = ports;
  const start = store.starts().find((entry) => entry.id === id);
  if (start === undefined || start.error !== null || running.has(id)) return null;
  running.add(id);
  const dismissed = () => !store.starts().some((entry) => entry.id === id);
  const stopped = () => dismissed() || !ports.orbitMode();
  try {
    if (!(await ports.catalogReady())) {
      store.save({
        ...start,
        error: "Conn's saved environments did not load.",
        errorCode: null,
      });
      return null;
    }
    let environmentId: string | null = null;
    const sent = await runOrbitThreadStart(start, {
      client: afterSave(store, ports.gateway),
      save: store.save,
      sleep: ports.sleep,
      now: ports.now,
      stopped,
      dismissed,
      isSaved: ports.isSaved,
      reservationPairing: ports.reservationPairing,
      waitForReservationPairing: ports.waitForReservationPairing,
      nameFits: ports.nameFits,
      connect: async (environmentId, pairingUrl, installId) => {
        await store.flush();
        await ports.connect(environmentId, pairingUrl, installId);
      },
      send: async (ready) => {
        await store.flush();
        environmentId = ready.environmentId;
        const projectId = await sendOrbitFirstMessage(ready, { ...ports.firstMessage, stopped });
        // A clone is a new environment: without its ref the selected workspace hides the thread.
        await ports.keepInWorkspace(
          start.workspaceId ?? null,
          `${ready.environmentId}:${projectId}`,
        );
      },
    });
    if (!sent || environmentId === null) return null;
    // The create's completion runs on after the send: the runner keeps the start and its row
    // follows it (`orbitSentStartStep`). Without one (an older Gateway) the start is done.
    return { environmentId, threadId: start.threadId };
  } finally {
    running.delete(id);
  }
}

/**
 * What the runner does with a sent start: drop it (nothing left to show), mark it as followed
 * after the send (also a start saved by a build or a run that stopped before it marked it), or
 * follow its completion.
 */
export function orbitSentStartStep(start: OrbitThreadStart): "drop" | "mark" | "follow" {
  if (orbitCompletionSettled(start)) return "drop";
  return start.pendingThread === true ? "follow" : "mark";
}

/**
 * A sent start with nothing left to show: its completion succeeded, a removal cancelled it (the
 * removal takes the thread away), or it has none (an older Gateway). Its row goes.
 */
export function orbitCompletionSettled(start: OrbitThreadStart): boolean {
  if (start.sentAt == null) return false;
  const phase = orbitCompletionPhase(start);
  return phase === "none" || phase === "succeeded" || phase === "removed";
}

function completionPorts(
  id: string,
  ports: Pick<MobileOrbitThreadStartPorts, "store" | "gateway" | "sleep" | "now">,
): OrbitCompletionPorts {
  return {
    client: afterSave(ports.store, ports.gateway),
    read: () => ports.store.starts().find((entry) => entry.id === id) ?? null,
    // Saves only a start that is still there: a Dismiss wins.
    save: ports.store.save,
    sleep: ports.sleep,
    now: ports.now,
  };
}

/** Completions and Retries this app session works on, so a re-run of the runner does each once. */
const following = new Set<string>();

/** After a follow stopped quietly (Gateway away, read refused), the wait before the next one. */
const REFOLLOW_MS = 30_000;

/**
 * Follows a sent start's completion, or sends its unanswered Retry and then follows the new
 * Operation, as the desktop's runner does. A restart resumes from the saved Operation id or key.
 */
export async function followSavedOrbitCompletion(
  id: string,
  ports: Pick<MobileOrbitThreadStartPorts, "store" | "gateway" | "sleep" | "now" | "orbitMode">,
): Promise<void> {
  const start = ports.store.starts().find((entry) => entry.id === id);
  if (start === undefined || !ports.orbitMode() || following.has(id)) return;
  const follow = orbitCompletionNeedsFollow(start);
  if (!follow && !orbitCompletionNeedsAdmission(start)) return;
  following.add(id);
  try {
    const completion = completionPorts(id, ports);
    if (!follow) await admitOrbitCompletion(completion);
    // An admitted Retry is followed at once: its save came while this run still held the id. A
    // follow that stopped quietly starts again after a wait, as the desktop's next runner pass.
    for (;;) {
      const fresh = completion.read();
      if (fresh === null || !ports.orbitMode() || !orbitCompletionNeedsFollow(fresh)) return;
      if ((await followOrbitCompletion(completion)) !== "lost") return;
      await ports.sleep(REFOLLOW_MS);
    }
  } finally {
    following.delete(id);
  }
}

/** Retry of a failed or cancelled completion: saves a new key; the runner sends it. */
export function retrySavedOrbitCompletion(
  id: string,
  ports: Pick<MobileOrbitThreadStartPorts, "store" | "now">,
): boolean {
  return markOrbitCompletionRetry({
    read: () => ports.store.starts().find((entry) => entry.id === id) ?? null,
    save: ports.store.save,
    now: ports.now,
  });
}

/**
 * One runner pass over a sent start: drops it, marks it as followed (a save that changes the list,
 * so the next pass follows it), or follows its completion.
 */
export async function runSentOrbitThreadStart(
  start: OrbitThreadStart,
  ports: Pick<MobileOrbitThreadStartPorts, "store" | "gateway" | "sleep" | "now" | "orbitMode">,
): Promise<void> {
  const step = orbitSentStartStep(start);
  if (step === "drop") {
    ports.store.update((starts) => starts.filter((entry) => entry.id !== start.id));
  } else if (step === "mark") {
    ports.store.save({ ...start, pendingThread: true });
  } else {
    await followSavedOrbitCompletion(start.id, ports);
  }
}
