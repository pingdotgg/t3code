import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { mostWorkedRepositories } from "@t3tools/client-runtime/state/threads";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  BOAT_CLOUD_SNAPSHOT_REPOSITORIES,
  type BoatCloudAcquireInput,
  type BoatCloudSession,
  type BoatCloudStartStep,
  type BoatCloudStatus,
  type EnvironmentId,
  isBoatCloudHttpBaseUrl,
} from "@t3tools/contracts";
import { boatCloudProviderDrivers, parseRepository } from "@t3tools/shared/boatCloudVm";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  type BoatCloudStartProgress,
  completeStep,
  failProgress,
  markAcquired,
  markSent,
  startingProgress,
  stepsLeftAtSend,
  wakingProgress,
  withHolderSteps,
} from "./boatCloudStart.logic";
import type { DraftId } from "./composerDraftStore";
import type { BoatCloudStartRowsState } from "./components/chat/WorktreeSetupCard";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { environmentCatalog } from "./connection/catalog";
import { connectPairing } from "./connection/onboarding";
import { randomUUID } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  readEnvironment,
  readPrimaryEnvironmentId,
  useEnvironment,
  usePrimaryEnvironmentId,
} from "./state/environments";
import { environmentPresentations, environmentSummaries } from "./state/presentation";
import { threadEnvironment } from "./state/threads";
import { environmentSession, sessionHasScope } from "./state/session";
import { environmentProjects } from "./state/projects";
import { useEnvironmentQuery } from "./state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "./state/server";
import { waitForAtomValue } from "./state/waitForAtomValue";

/**
 * Boat cloud VMs are ordinary environments. This machine (the primary
 * environment) holds the Boat key, hands out a VM, and the client pairs with it.
 */

const PROJECT_APPEAR_TIMEOUT_MS = 60_000;
/** The checkout and worktree run in one VM command, which the holder gives ten minutes. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;
const RECONNECT_TIMEOUT_MS = 15_000;

/** An environment's Boat cloud status, while it is connected. */
export function useBoatCloudStatus(environmentId: EnvironmentId | null): BoatCloudStatus | null {
  const connected = useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
  return useEnvironmentQuery(
    environmentId !== null && connected.includes(environmentId)
      ? serverEnvironment.boatCloudStatus({ environmentId, input: {} })
      : null,
  ).data;
}

/**
 * Each connected machine's Boat status: null while it loads, "unsupported" when its
 * T3 Code predates Boat cloud and cannot take the key.
 */
const boatCloudKeyHolderStatesAtom = Atom.make((get) => {
  const states = new Map<EnvironmentId, BoatCloudStatus | "unsupported" | null>();
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config === null) {
      states.set(environmentId, null);
    } else if (config.environment.capabilities.boatCloud !== true) {
      states.set(environmentId, "unsupported");
    } else {
      const status = get(serverEnvironment.boatCloudStatus({ environmentId, input: {} }));
      states.set(
        environmentId,
        AsyncResult.getOrElse(status, () => null),
      );
    }
  }
  return states;
}).pipe(Atom.withLabel("boat-cloud:key-holder-states"));

export function useBoatCloudKeyHolderStates() {
  return useAtomValue(boatCloudKeyHolderStatesAtom);
}

/** The status of this machine, which hands out VMs for the threads started here. */
export function usePrimaryBoatCloudStatus() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return {
    holderEnvironmentId: primaryEnvironmentId,
    status: useBoatCloudStatus(primaryEnvironmentId),
  };
}

/** The providers a new Boat VM has sign-ins for, or null when Boat's credentials are unknown. */
export function useBoatCloudProviderDrivers() {
  const { status } = usePrimaryBoatCloudStatus();
  const chosen = status?.environments.find(
    (environment) => environment.name === status.environment,
  );
  return chosen?.agentCredentials ? boatCloudProviderDrivers(chosen.agentCredentials) : null;
}

export function boatCloudReady(status: BoatCloudStatus | null) {
  return status?.connected === true && (status.setup.status === "ready" || status.snapshotReady);
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: failureMessage(result) }),
  );
}

/** The start in progress for each draft, shown above its composer. */
export const boatCloudStartProgressAtom = Atom.family((_draftId: string) =>
  Atom.make<BoatCloudStartProgress | null>(null).pipe(Atom.keepAlive),
);

function updateProgress(
  draftId: DraftId | null,
  update: (progress: BoatCloudStartProgress) => BoatCloudStartProgress,
) {
  if (draftId === null) return;
  const atom = boatCloudStartProgressAtom(draftId);
  const current = appAtomRegistry.get(atom);
  if (current) appAtomRegistry.set(atom, update(current));
}

/** The draft's send now waits on its start, so the thread shows the steps still left. */
export function markBoatCloudStartSent(draftId: DraftId | null) {
  updateProgress(draftId, (progress) => markSent(progress, new Date().toISOString()));
}

/** The send stopped waiting without going out; the steps leave the thread. */
export function unmarkBoatCloudStartSent(draftId: DraftId | null) {
  updateProgress(draftId, (progress) => ({ ...progress, sent: null }));
}

/** Ends the draft's start, once its thread is created or it leaves Boat cloud. */
export function clearBoatCloudStartProgress(draftId: DraftId) {
  prewarmed.delete(draftId);
  appAtomRegistry.set(boatCloudStartProgressAtom(draftId), null);
}

/** Boat cloud VMs this client already paired with, so the holder skips their pairing code. */
function pairedBoatCloudEnvironments(): NonNullable<BoatCloudAcquireInput["paired"]> {
  const paired: Array<{ environmentId: EnvironmentId; httpBaseUrl: string }> = [];
  for (const [environmentId, presentation] of appAtomRegistry.get(
    environmentPresentations.presentationsAtom,
  )) {
    const httpBaseUrl = connectionCatalogDisplayUrl(presentation.entry);
    if (httpBaseUrl !== null && isBoatCloudHttpBaseUrl(httpBaseUrl)) {
      paired.push({ environmentId, httpBaseUrl });
    }
  }
  return paired;
}

const isConnected = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom).includes(environmentId);

/**
 * Connects this client to the VM: with its saved credential when the holder sent
 * no pairing code, else by pairing. Returns the failure text.
 */
async function attach(session: BoatCloudSession): Promise<string | null> {
  if (isConnected(session.environmentId)) return null;
  if (session.pairingCode === null) {
    // A stopped VM left its connection backing off; retry now that the server is up.
    void environmentCatalog.retryNow.run(appAtomRegistry, session.environmentId);
    const reconnected = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentSummaries.connectedEnvironmentIdsAtom,
      predicate: (ids) => ids.includes(session.environmentId),
      timeoutMs: RECONNECT_TIMEOUT_MS,
    });
    return reconnected ? null : "Could not reconnect to the VM.";
  }
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    {
      host: session.httpBaseUrl,
      pairingCode: session.pairingCode,
      expectedEnvironmentId: session.environmentId,
      codeIsForExpectedEnvironment: true,
    },
    { label: connectPairing.label, reportFailure: false, reportDefect: true },
  );
  if (paired._tag === "Success" || isAtomCommandInterrupted(paired)) return null;
  return failureMessage(paired);
}

interface BoatCloudPrepareInput {
  readonly draftId: DraftId;
  readonly holderEnvironmentId: EnvironmentId;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
}

/** Where the draft moves: the VM's project, and the worktree the VM cut for it when it did. */
export interface BoatCloudTarget {
  readonly project: EnvironmentProject;
  readonly worktree: BoatCloudSession["worktree"] | null;
}

/**
 * Gets a VM with the repository checked out and returns its project there,
 * so the draft can move onto it and send. Progress goes to the draft's
 * `boatCloudStartProgressAtom`; the caller completes the "thread" step.
 * Null when it failed, with the failure in the progress.
 */
async function prepareBoatCloudProjectNow(
  input: BoatCloudPrepareInput,
): Promise<BoatCloudTarget | null> {
  const { draftId } = input;
  const progressAtom = boatCloudStartProgressAtom(draftId);
  appAtomRegistry.set(
    progressAtom,
    startingProgress(
      parseRepository(input.repositoryUrl)?.name ?? null,
      appAtomRegistry.get(progressAtom),
    ),
  );
  // The holder logs its own steps as "boat cloud start timing"; this is the client's share.
  const startedAt = performance.now();
  const endedAtMs: Record<string, number> = {};
  const markEnded = (step: string) => {
    endedAtMs[step] = Math.round(performance.now() - startedAt);
  };
  const logTiming = (outcome: "ready" | "failed") =>
    console.info("[boat-cloud] start timing", {
      outcome,
      totalMs: Math.round(performance.now() - startedAt),
      endedAtMs,
    });
  const fail = (error: string, step?: BoatCloudStartStep) => {
    updateProgress(draftId, (progress) => failProgress(progress, error, step));
    logTiming("failed");
    return null;
  };
  let requestId = randomUUID();
  // The holder reports its steps under the request id, the checkout's after the acquire returns.
  let repositoryFailed: (error: string) => void = () => undefined;
  let repositoryDone: () => void = () => undefined;
  const watchCheckout = () => ({
    failure: new Promise<string>((resolve) => {
      repositoryFailed = resolve;
    }),
    done: new Promise<true>((resolve) => {
      repositoryDone = () => resolve(true);
    }),
  });
  let checkout = watchCheckout();
  const stopWatchingHolder = appAtomRegistry.subscribe(
    serverEnvironment.boatCloudStatus({ environmentId: input.holderEnvironmentId, input: {} }),
    (result) => {
      const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (!start) return;
      updateProgress(draftId, (progress) => withHolderSteps(progress, start.steps));
      const repository = start.steps.find((entry) => entry.step === "repository");
      if (repository?.state === "failed") {
        repositoryFailed(repository.detail ?? "Could not get the repository on the VM.");
      }
      if (repository?.state === "done") repositoryDone();
    },
  );
  try {
    const acquire = (paired: BoatCloudAcquireInput["paired"]) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.acquireBoatCloud,
        {
          environmentId: input.holderEnvironmentId,
          input: {
            repositoryUrl: input.repositoryUrl,
            baseBranch: input.baseBranch,
            requestId,
            paired,
          },
        },
        {
          label: serverEnvironment.acquireBoatCloud.label,
          reportFailure: false,
          reportDefect: true,
        },
      );
    let acquired = await acquire(pairedBoatCloudEnvironments());
    if (acquired._tag === "Failure") {
      if (isAtomCommandInterrupted(acquired)) {
        clearBoatCloudStartProgress(draftId);
        return null;
      }
      return fail(failureMessage(acquired));
    }
    updateProgress(draftId, markAcquired);
    markEnded("acquire");
    let attachFailure = await attach(acquired.value);
    if (attachFailure !== null) {
      // The saved credential no longer works, or the VM did not answer, so start once more
      // and pair as a new client. A VM that does not answer gets no new thread.
      requestId = randomUUID();
      checkout = watchCheckout();
      acquired = await acquire([]);
      if (acquired._tag === "Failure") {
        if (isAtomCommandInterrupted(acquired)) {
          clearBoatCloudStartProgress(draftId);
          return null;
        }
        return fail(failureMessage(acquired), "connect");
      }
      attachFailure = await attach(acquired.value);
    }
    if (attachFailure !== null) return fail(attachFailure, "connect");
    updateProgress(draftId, (progress) => completeStep(progress, "connect"));
    markEnded("connect");
    const session = acquired.value;

    // Uploads need the VM's server config and the send needs its operate grant,
    // so the draft moves once all three have arrived. A thread that takes the VM's worktree
    // also waits for the holder to say it is cut.
    const worktree = session.worktree ?? null;
    const findProject = (projects: ReadonlyArray<EnvironmentProject>) =>
      projects.find(
        (project) =>
          project.environmentId === session.environmentId &&
          project.workspaceRoot === session.workspaceRoot,
      );
    const arrived = await Promise.race([
      Promise.all([
        waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentProjects.projectsAtom,
          predicate: (projects) => findProject(projects) !== undefined,
          timeoutMs: PROJECT_APPEAR_TIMEOUT_MS,
        }),
        waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentServerConfigsAtom,
          predicate: (configs) => configs.has(session.environmentId),
          timeoutMs: PROJECT_APPEAR_TIMEOUT_MS,
        }),
        waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentSession.sessionStateAtom(session.environmentId),
          predicate: (result) => sessionHasScope(result, AuthOrchestrationOperateScope),
          timeoutMs: PROJECT_APPEAR_TIMEOUT_MS,
        }),
        worktree === null
          ? true
          : Promise.race([
              checkout.done,
              new Promise<false>((resolve) =>
                setTimeout(() => resolve(false), CHECKOUT_TIMEOUT_MS),
              ),
            ]),
      ]),
      checkout.failure,
    ]);
    if (typeof arrived === "string") return fail(arrived, "repository");
    const project = findProject(appAtomRegistry.get(environmentProjects.projectsAtom));
    if (arrived.includes(false) || !project) return fail("The VM did not open the project.");
    // The project is added after the checkout, so it appearing means the checkout is done.
    updateProgress(draftId, (progress) =>
      completeStep(completeStep(progress, "repository"), "project"),
    );
    markEnded("project");
    logTiming("ready");
    return { project, worktree };
  } finally {
    stopWatchingHolder();
  }
}

/** The start each draft began when Boat cloud was picked, so its send can reuse it. */
const prewarmed = new Map<
  DraftId,
  { readonly repositoryUrl: string; readonly target: Promise<BoatCloudTarget | null> }
>();

/**
 * Starts getting a VM as soon as the draft picks Boat cloud, so it is usually
 * ready by the time the message is written. VMs stop by themselves when unused.
 */
export function prewarmBoatCloudProject(input: BoatCloudPrepareInput) {
  if (prewarmed.get(input.draftId)?.repositoryUrl === input.repositoryUrl) return;
  prewarmed.set(input.draftId, {
    repositoryUrl: input.repositoryUrl,
    target: prepareBoatCloudProjectNow(input),
  });
}

/** The draft's pre-warmed start when it is for this repository and did not fail, else a new one. */
export async function prepareBoatCloudProject(
  input: BoatCloudPrepareInput,
): Promise<BoatCloudTarget | null> {
  const started = prewarmed.get(input.draftId);
  prewarmed.delete(input.draftId);
  if (started?.repositoryUrl === input.repositoryUrl) {
    const target = await started.target;
    if (target !== null) return target;
  }
  return prepareBoatCloudProjectNow(input);
}

const WAKE_CONNECT_TIMEOUT_MS = 90_000;
const wakesInFlight = new Map<EnvironmentId, Promise<boolean>>();

/** The wake this client runs for each VM, so its thread shows the steps rather than "Sleeping". */
const boatCloudWakeProgressAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make<BoatCloudStartProgress | null>(null).pipe(Atom.keepAlive),
);

function updateWake(
  environmentId: EnvironmentId,
  update: (progress: BoatCloudStartProgress) => BoatCloudStartProgress,
) {
  const atom = boatCloudWakeProgressAtom(environmentId);
  const current = appAtomRegistry.get(atom);
  if (current) appAtomRegistry.set(atom, update(current));
}

/** The steps of this client's wake of the VM, for its thread to show under the waiting message. */
export function useBoatCloudWakeRows(environmentId: EnvironmentId | null): {
  rows: BoatCloudStartRowsState | null;
  startedAt: string | null;
} {
  const progress = useAtomValue(boatCloudWakeProgressAtom(environmentId));
  const steps = stepsLeftAtSend(progress);
  if (!steps || !progress?.sent) return { rows: null, startedAt: null };
  return { rows: { steps, repository: null, waking: true }, startedAt: progress.sent.at };
}

/**
 * Turns a stopped or deleted VM back on, from this machine's copy, and resolves
 * once this client is connected to it again. False after telling the user what failed.
 */
function wakeBoatCloudMachine(input: {
  readonly holderEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string | null;
}): Promise<boolean> {
  const inFlight = wakesInFlight.get(input.environmentId);
  if (inFlight) return inFlight;
  const { environmentId } = input;
  appAtomRegistry.set(
    boatCloudWakeProgressAtom(environmentId),
    wakingProgress(new Date().toISOString()),
  );
  // The holder reports the machine and server steps under the request id.
  const requestId = randomUUID();
  const stopWatchingHolder = appAtomRegistry.subscribe(
    serverEnvironment.boatCloudStatus({ environmentId: input.holderEnvironmentId, input: {} }),
    (result) => {
      const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (start) updateWake(environmentId, (progress) => withHolderSteps(progress, start.steps));
    },
  );
  const wake = (async () => {
    const woken = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.wakeBoatCloud,
      {
        environmentId: input.holderEnvironmentId,
        input: {
          environmentId,
          requestId,
          ...(input.httpBaseUrl ? { httpBaseUrl: input.httpBaseUrl } : {}),
        },
      },
      { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
    );
    if (woken._tag === "Failure") {
      reportFailure("Could not wake the Boat cloud machine", woken);
      return false;
    }
    updateWake(environmentId, markAcquired);
    // A restored VM has a new address, so the holder pairs again rather than wait for the old one.
    const attachFailure = await attach(woken.value);
    if (attachFailure !== null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect to Boat cloud",
          description: attachFailure,
        }),
      );
      return false;
    }
    // The send that follows needs the VM's grant too, which loads just after it connects.
    const connected =
      (await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentSummaries.connectedEnvironmentIdsAtom,
        predicate: (ids) => ids.includes(input.environmentId),
        timeoutMs: WAKE_CONNECT_TIMEOUT_MS,
      })) &&
      (await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentSession.sessionStateAtom(input.environmentId),
        predicate: (result) => sessionHasScope(result, AuthOrchestrationOperateScope),
        timeoutMs: WAKE_CONNECT_TIMEOUT_MS,
      }));
    if (connected) updateWake(environmentId, (progress) => completeStep(progress, "connect"));
    if (!connected) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect to Boat cloud",
          description: "The machine is on, but this client did not reach it in time.",
        }),
      );
    }
    return connected;
  })().finally(() => {
    stopWatchingHolder();
    wakesInFlight.delete(environmentId);
    appAtomRegistry.set(boatCloudWakeProgressAtom(environmentId), null);
  });
  wakesInFlight.set(input.environmentId, wake);
  return wake;
}

/**
 * Wakes a Boat VM that is not connected before an action runs on it. False when it
 * could not be woken; true when it is connected or is not a Boat VM at all.
 */
export function wakeBoatCloudIfAsleep(environmentId: EnvironmentId): Promise<boolean> {
  if (isConnected(environmentId)) return Promise.resolve(true);
  const environment = readEnvironment(environmentId);
  const holderEnvironmentId = readPrimaryEnvironmentId();
  if (
    environment?.boatCloud !== true ||
    holderEnvironmentId === null ||
    holderEnvironmentId === environmentId
  ) {
    return Promise.resolve(true);
  }
  return wakeBoatCloudMachine({
    holderEnvironmentId,
    environmentId,
    httpBaseUrl: environment.displayUrl ?? null,
  });
}

export interface BoatCloudSleep {
  readonly state: "sleeping" | "waking";
  /** Turns the VM on and resolves once it is connected; false when that failed. */
  readonly wake: () => Promise<boolean>;
}

/**
 * A Boat VM that is not reachable is asleep: it stopped itself after its threads
 * went quiet. The next message wakes it, so its thread reads "Sleeping", not offline.
 * Any environment at a Boat URL counts, not only the VMs in this machine's list.
 */
export function useBoatCloudSleep(
  environmentId: EnvironmentId | null,
  phase: EnvironmentConnectionPhase | null,
): BoatCloudSleep | null {
  const holderEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const waking = useAtomValue(boatCloudWakeProgressAtom(environmentId)) !== null;
  const httpBaseUrl = environment?.displayUrl ?? null;
  if (
    environment?.boatCloud !== true ||
    environmentId === null ||
    holderEnvironmentId === null ||
    phase === null ||
    phase === "connected"
  ) {
    return null;
  }
  // Retries cycle the phase, so only this client's own wake reads as waking.
  return {
    state: waking ? "waking" : "sleeping",
    wake: () => wakeBoatCloudMachine({ holderEnvironmentId, environmentId, httpBaseUrl }),
  };
}

/** What the Boat cloud snapshot checks out: the most worked repositories on every machine. */
export function boatCloudSnapshotRepositories(): Array<string> {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return mostWorkedRepositories(
    [...enabledEnvironmentIds(catalog)].map((environmentId) =>
      appAtomRegistry.get(threadEnvironment.snapshotAtom(environmentId)),
    ),
    BOAT_CLOUD_SNAPSHOT_REPOSITORIES,
  );
}
