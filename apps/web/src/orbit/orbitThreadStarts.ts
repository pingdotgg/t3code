import {
  admitOrbitCompletion,
  cancelOrbitCompletion,
  cancelOrbitCreate,
  followOrbitCompletion,
  markOrbitCompletionRetry,
  newOrbitThreadStart,
  OPERATION_TERMINAL_STATUSES,
  type OrbitCompletionPorts,
  orbitThreadStartCreatedInstance,
  retryOrbitThreadStartRecord,
  runOrbitThreadStart,
  type OrbitModelFallback,
  sendOrbitFirstMessage,
  type OrbitFirstMessagePorts,
  type OrbitGatewayClient,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { keepProjectInWorkspace, useWorkspaceStore } from "../workspaceStore";
import { recordOrbitPaired, useEnvironmentProvider } from "./environmentProvider";
import { wakeOrbitInstanceForStart } from "./orbitInstanceSleep";
import type { OrbitDraftStartInput } from "./orbitDraft";
import {
  readStored,
  recordCreateOperation,
  saveStart,
  updateStarts,
} from "./orbitThreadStartStore";
import { rememberOrbitComposerControls } from "./orbitComposerControls";
import { getOrbitReservations, takeOrbitReservation } from "./orbitReservations";

/** Conn: runs the threads started in an Orbit Project (FORK.md, "Orbit"), in the main window only. */

/** The clone's T3 project: the create flow adds the container's workspace. */
const ORBIT_CLONE_WORKSPACE = "/srv/workspace";
const CLONE_READY_TIMEOUT_MS = 60_000;

/** Saves the start an Orbit draft sends: the typed Instance name, kind, model and modes. */
function saveOrbitDraftStart(input: OrbitDraftStartInput): OrbitThreadStart {
  const fresh = newOrbitThreadStart({
    id: randomUUID(),
    project: input.project,
    message: input.message,
    suffix: randomUUID().slice(0, 6),
    threadId: newThreadId(),
    messageId: newMessageId(),
    commandId: randomUUID(),
    now: Date.now(),
    instanceName: input.instanceName,
    ...(input.existing ? { existing: input.existing } : {}),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    pendingThread: true,
    projectName: input.projectName ?? null,
    instanceDomainSuffix: input.instanceDomainSuffix ?? null,
    branch: input.branch,
    defaultBranch: input.defaultBranch,
    // Conn: the clone reserved while the prompt box was open; the start finalizes it.
    reservation: input.instanceKind === "new" ? takeOrbitReservation(input.project.id) : null,
  });
  const start = { ...fresh, workspaceId: useWorkspaceStore.getState().activeWorkspaceId };
  updateStarts((starts) => [...starts, start]);
  return start;
}

/** The pending thread of a start, shown until the clone's server took the first message. */
export function orbitPendingThreadPath(startId: string): string {
  return `/orbit/${startId}`;
}

/** Why a start cannot run in this window, or null: it needs the desktop's Gateway client and Orbit mode. */
export function orbitThreadStartBlockedReason(): string | null {
  if (window.desktopBridge?.orbitGatewaySend === undefined) {
    return "Threads in an Orbit Project start only in the Conn desktop app. Open this Project there.";
  }
  if (useEnvironmentProvider.getState().provider !== "orbit") {
    return "Choose Orbit under Settings › Environments › Environments from, then try again.";
  }
  return null;
}

/**
 * Sends an Orbit draft: saves the start for the runner (never through a T3 server), opens its
 * pending thread, then clears the draft. Null, with the draft kept, when the start cannot run.
 * The draft goes only once the route left it: a draft route without its draft redirects home.
 */
export function sendOrbitDraft(input: {
  readonly start: OrbitDraftStartInput;
  readonly openPending: (path: string) => Promise<void> | void;
  readonly clearDraft: () => void;
}): OrbitThreadStart | null {
  if (orbitThreadStartBlockedReason() !== null) return null;
  const start = saveOrbitDraftStart(input.start);
  // The pending thread's disabled prompt box shows the same model controls as the draft did.
  rememberOrbitComposerControls(start.id);
  void Promise.resolve(input.openPending(orbitPendingThreadPath(start.id)))
    .finally(input.clearDraft)
    .catch(() => {});
  return start;
}

export function retryOrbitThreadStart(id: string): void {
  updateStarts((starts) =>
    starts.map((start) => (start.id === id ? retryOrbitThreadStartRecord(start) : start)),
  );
}

export function dismissOrbitThreadStart(id: string): void {
  updateStarts((starts) => starts.filter((start) => start.id !== id));
}

/**
 * Cancels Orbit's admitted create, or its completion once it succeeded, then drops the start; a
 * failed cancel keeps it and throws. A create sent but not answered only marks the start
 * (`requested`): the main window's runner cancels it once admitted. The Instance stays.
 */
export async function cancelOrbitThreadStart(
  client: OrbitGatewayClient | null,
  id: string,
): Promise<{ readonly instanceStays: boolean; readonly requested: boolean }> {
  const start = readStored().find((entry) => entry.id === id);
  if (start === undefined) return { instanceStays: false, requested: false };
  const admitting =
    start.environmentId === null && start.createOperationId === null && start.createKey != null;
  if (admitting) {
    updateStarts((starts) =>
      starts.map((entry) => (entry.id === id ? { ...entry, cancelRequested: true } : entry)),
    );
    return { instanceStays: true, requested: true };
  }
  if (start.createOperationId !== null && start.environmentId === null) {
    if (client === null) throw new Error(NO_GATEWAY_TEXT);
    await cancelOrbitCreate(client, start.createOperationId);
  } else if (completionStillRuns(start)) {
    // The create succeeded but the thread has not opened: its completion is what still runs.
    if (client === null) throw new Error(NO_GATEWAY_TEXT);
    await cancelOrbitCompletion(client, start.completionOperationId!);
  }
  dismissOrbitThreadStart(id);
  return { instanceStays: orbitThreadStartCreatedInstance(start), requested: false };
}

const NO_GATEWAY_TEXT = "Conn cannot reach the Orbit Gateway from this window.";

/**
 * A Cancel before the thread opened, after the create succeeded. The saved status stays "queued"
 * until the thread opens; a completion that ended meanwhile is read back by the cancel.
 */
function completionStillRuns(start: OrbitThreadStart): boolean {
  return (
    start.environmentId !== null &&
    start.sentAt == null &&
    typeof start.completionOperationId === "number" &&
    (start.completionStatus == null || !OPERATION_TERMINAL_STATUSES.has(start.completionStatus))
  );
}

const cancelRequested = (id: string) =>
  readStored().find((entry) => entry.id === id)?.cancelRequested === true;

export function isOrbitServerSaved(environmentId: string): boolean {
  return appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.has(environmentId as EnvironmentId);
}

/** Opens a clone's one-time pairing link and saves its server. */
export async function connectOrbitClone(
  environmentId: string,
  pairingUrl: string,
  installId?: string,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    {
      pairingUrl,
      expectedEnvironmentId: EnvironmentId.make(environmentId),
      ...(installId === undefined ? {} : { provisionalPairingId: installId }),
    },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    throw new Error(
      `Could not pair with the clone: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (installId === undefined) recordOrbitPaired(environmentId);
}

/** The clone's workspace project and its server's default model, once both loaded. */
async function waitForClone(environmentId: string) {
  const id = environmentId as EnvironmentId;
  const findProject = () =>
    appAtomRegistry
      .get(environmentProjects.projectsAtom)
      .find(
        (project) =>
          project.environmentId === id && project.workspaceRoot === ORBIT_CLONE_WORKSPACE,
      );
  const ready = await waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentProjects.projectsAtom,
    predicate: () => findProject() !== undefined,
    timeoutMs: CLONE_READY_TIMEOUT_MS,
  });
  const configured = await waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentServerConfigsAtom,
    predicate: (configs) => configs.has(id),
    timeoutMs: CLONE_READY_TIMEOUT_MS,
  });
  const project = findProject();
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(id);
  if (!ready || !configured || project === undefined || config === undefined) return null;
  const projectId = ProjectId.make(project.id);
  const entries = providerInstanceEntriesFor(config.providers, config.settings, projectId);
  return {
    projectId,
    modelSelection:
      config.settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(config.providers, config.settings, projectId),
    offers: (selection: { readonly instanceId: string }) =>
      // Only an enabled provider counts; one still being checked is not a reason to fall back.
      entries.some((entry) => entry.instanceId === selection.instanceId && entry.enabled),
  };
}

const firstMessagePorts: OrbitFirstMessagePorts = {
  waitForClone,
  startTurn: async (environmentId, input) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      { environmentId: environmentId as EnvironmentId, input },
      { reportFailure: false },
    );
    return result._tag === "Success"
      ? { ok: true }
      : { ok: false, error: squashAtomCommandFailure(result) };
  },
  now: () => new Date().toISOString(),
  stopped: () => false,
};

const running = new Set<string>();

/**
 * Runs a start from its last saved step, once per window at a time. Resolves the thread it sent
 * the first message in, or null when the start stopped (its `error` says why).
 */
export async function runSavedOrbitThreadStart(
  client: OrbitGatewayClient,
  id: string,
  /** `onCancelled`: the runner cancelled the create a Cancel during admission asked for. */
  options: { readonly onCancelled?: () => void } = {},
): Promise<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null> {
  const start = readStored().find((entry) => entry.id === id);
  if (start !== undefined && start.sentAt != null && !start.pendingThread) {
    // A start of the removed sidebar dialog whose send finished before a quit: only its dismiss is left.
    dismissOrbitThreadStart(id);
    return null;
  }
  if (start === undefined || start.error !== null || start.sentAt != null || running.has(id)) {
    return null;
  }
  running.add(id);
  // Dismiss removes the start; a switch to Default pauses it until Orbit mode is back.
  const dismissed = () => !readStored().some((entry) => entry.id === id);
  const stopped = () => dismissed() || useEnvironmentProvider.getState().provider !== "orbit";
  try {
    // Whether the device saved the clone's server is known only once the catalog loaded.
    const catalogReady = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentCatalog.catalogValueAtom,
      predicate: (catalog) => catalog.isReady,
      timeoutMs: CLONE_READY_TIMEOUT_MS,
    });
    if (!catalogReady) {
      saveStart({ ...start, error: "Conn's saved environments did not load.", errorCode: null });
      return null;
    }
    let environmentId: string | null = null;
    const reservations =
      start.reservationId && start.environmentId === null ? getOrbitReservations() : null;
    const sent = await runOrbitThreadStart(start, {
      client,
      // Only the UI sets a Cancel request, so a save of the runner's copy keeps it.
      save: (next) => saveStart({ ...next, cancelRequested: cancelRequested(id) }),
      cancelRequested: () => cancelRequested(id),
      cancelled: () => {
        dismissOrbitThreadStart(id);
        options.onCancelled?.();
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      stopped,
      dismissed,
      isSaved: isOrbitServerSaved,
      reservationPairing: reservations ?? undefined,
      waitForReservationPairing: reservations?.waitForPairing,
      connect: connectOrbitClone,
      wake: (instanceId) => wakeOrbitInstanceForStart(client, instanceId),
      onCreateOperation: (operation) => recordCreateOperation(id, operation),
      send: async (ready) => {
        environmentId = ready.environmentId;
        let modelFallback: OrbitModelFallback | null = null;
        const projectId = await sendOrbitFirstMessage(ready, {
          ...firstMessagePorts,
          stopped,
          onModelFallback: (fallback) => {
            modelFallback = fallback;
          },
        });
        // A clone is a new environment: without its ref the workspace would hide the thread.
        keepProjectInWorkspace(start.workspaceId ?? null, `${ready.environmentId}:${projectId}`);
        return { modelFallback };
      },
    });
    if (!sent || environmentId === null) return null;
    // The start stays for the real thread's "Instance ready" row.
    return {
      environmentId: environmentId as EnvironmentId,
      threadId: ThreadId.make(start.threadId),
    };
  } finally {
    running.delete(id);
  }
}

/** Completions this window follows, by start and Operation, so a re-run of the runner follows each once. */
const following = new Set<string>();

function completionPorts(client: OrbitGatewayClient, id: string): OrbitCompletionPorts {
  return {
    client,
    read: () => readStored().find((entry) => entry.id === id) ?? null,
    // Saves only a start that is still there: a Dismiss in another window wins.
    save: (next) =>
      updateStarts((starts) => starts.map((entry) => (entry.id === id ? next : entry))),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}

/**
 * Follows a sent start's completion (main window's runner only). Other windows render the saved
 * rows and status; a restart resumes from the saved Operation id.
 */
export async function followSavedOrbitCompletion(
  client: OrbitGatewayClient,
  id: string,
): Promise<void> {
  const operationId = readStored().find((entry) => entry.id === id)?.completionOperationId;
  if (operationId == null) return;
  const key = `${id}:${operationId}`;
  if (following.has(key)) return;
  following.add(key);
  try {
    // Only Orbit-mode windows follow; a switch to Default pauses it until Orbit mode is back.
    if (useEnvironmentProvider.getState().provider !== "orbit") return;
    await followOrbitCompletion(completionPorts(client, id));
  } finally {
    following.delete(key);
  }
}

/** Retries whose admission this window sends, by start, so a re-run of the runner sends it once. */
const admitting = new Set<string>();

async function onceAdmitting(id: string, run: () => Promise<void>): Promise<void> {
  if (admitting.has(id)) return;
  admitting.add(id);
  try {
    await run();
  } finally {
    admitting.delete(id);
  }
}

/**
 * Retry of a failed completion, from any window: it only saves the Retry. The main window's
 * runner sends it and then follows the new Operation, so two windows never send it twice.
 */
export function retrySavedOrbitCompletion(id: string): void {
  markOrbitCompletionRetry({
    read: () => readStored().find((entry) => entry.id === id) ?? null,
    save: (next) =>
      updateStarts((starts) => starts.map((entry) => (entry.id === id ? next : entry))),
    now: Date.now,
  });
}

/**
 * A Retry whose answer a reload or quit cut off: the main window's runner sends it again under
 * the saved key, so Orbit returns the Operation it may have admitted.
 */
export async function resumeSavedOrbitCompletionRetry(
  client: OrbitGatewayClient,
  id: string,
): Promise<void> {
  await onceAdmitting(id, () => admitOrbitCompletion(completionPorts(client, id)));
}
