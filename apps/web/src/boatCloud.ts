import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  type BoatCloudSession,
  type BoatCloudStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { boatCloudProviderDrivers, parseRepository } from "@t3tools/shared/boatCloudVm";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  type BoatCloudStartProgress,
  completeStep,
  failProgress,
  markAcquired,
  startingProgress,
  withHolderSteps,
} from "./boatCloudStart.logic";
import type { DraftId } from "./composerDraftStore";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { connectPairing } from "./connection/onboarding";
import { randomUUID } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { useEnvironment, usePrimaryEnvironmentId } from "./state/environments";
import { environmentSummaries } from "./state/presentation";
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

/** An environment's Boat cloud status, while it is connected. */
export function useBoatCloudStatus(environmentId: EnvironmentId | null): BoatCloudStatus | null {
  const connected = useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
  return useEnvironmentQuery(
    environmentId !== null && connected.includes(environmentId)
      ? serverEnvironment.boatCloudStatus({ environmentId, input: {} })
      : null,
  ).data;
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
  return status?.connected === true && status.setup.status === "ready";
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
  draftId: DraftId,
  update: (progress: BoatCloudStartProgress) => BoatCloudStartProgress,
) {
  const atom = boatCloudStartProgressAtom(draftId);
  const current = appAtomRegistry.get(atom);
  if (current) appAtomRegistry.set(atom, update(current));
}

/** Ends the draft's start, once its thread is created or it leaves Boat cloud. */
export function clearBoatCloudStartProgress(draftId: DraftId) {
  appAtomRegistry.set(boatCloudStartProgressAtom(draftId), null);
}

/** Pairs this client with the VM unless it is already connected. Returns the failure text. */
async function attach(session: BoatCloudSession): Promise<string | null> {
  const connected = appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom);
  if (connected.includes(session.environmentId)) return null;
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    {
      host: session.httpBaseUrl,
      pairingCode: session.pairingCode,
      expectedEnvironmentId: session.environmentId,
    },
    { label: connectPairing.label, reportFailure: false, reportDefect: true },
  );
  if (paired._tag === "Success" || isAtomCommandInterrupted(paired)) return null;
  return failureMessage(paired);
}

/**
 * Gets a VM with the repository checked out and returns its project there,
 * so the draft can move onto it and send. Progress goes to the draft's
 * `boatCloudStartProgressAtom`; the caller completes the "thread" step.
 * Null when it failed, with the failure in the progress.
 */
export async function prepareBoatCloudProject(input: {
  readonly draftId: DraftId;
  readonly holderEnvironmentId: EnvironmentId;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
}): Promise<EnvironmentProject | null> {
  const { draftId } = input;
  const requestId = randomUUID();
  appAtomRegistry.set(
    boatCloudStartProgressAtom(draftId),
    startingProgress(parseRepository(input.repositoryUrl)?.name ?? null),
  );
  const fail = (error: string) => {
    updateProgress(draftId, (progress) => failProgress(progress, error));
    return null;
  };
  // The holder reports its steps under the request id until the acquire returns.
  const stopWatchingHolder = appAtomRegistry.subscribe(
    serverEnvironment.boatCloudStatus({ environmentId: input.holderEnvironmentId, input: {} }),
    (result) => {
      const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (start) updateProgress(draftId, (progress) => withHolderSteps(progress, start.steps));
    },
  );
  const acquired = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.acquireBoatCloud,
    {
      environmentId: input.holderEnvironmentId,
      input: { repositoryUrl: input.repositoryUrl, baseBranch: input.baseBranch, requestId },
    },
    { label: serverEnvironment.acquireBoatCloud.label, reportFailure: false, reportDefect: true },
  ).finally(stopWatchingHolder);
  if (acquired._tag === "Failure") {
    if (isAtomCommandInterrupted(acquired)) {
      clearBoatCloudStartProgress(draftId);
      return null;
    }
    return fail(failureMessage(acquired));
  }
  updateProgress(draftId, markAcquired);
  const session = acquired.value;
  const attachFailure = await attach(session);
  if (attachFailure !== null) return fail(attachFailure);
  updateProgress(draftId, (progress) => completeStep(progress, "connect"));

  // Uploads need the VM's server config and the send needs its operate grant,
  // so the draft moves once all three have arrived.
  const findProject = (projects: ReadonlyArray<EnvironmentProject>) =>
    projects.find(
      (project) =>
        project.environmentId === session.environmentId &&
        project.workspaceRoot === session.workspaceRoot,
    );
  const [projectAppeared, configArrived, grantArrived] = await Promise.all([
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
  ]);
  const project = findProject(appAtomRegistry.get(environmentProjects.projectsAtom));
  if (!projectAppeared || !configArrived || !grantArrived || !project) {
    return fail("The VM did not open the project.");
  }
  updateProgress(draftId, (progress) => completeStep(progress, "project"));
  return project;
}

const WAKE_CONNECT_TIMEOUT_MS = 90_000;
const wakesInFlight = new Map<EnvironmentId, Promise<boolean>>();

/** Whether this client is turning a VM back on, so its thread shows "Waking" rather than "Sleeping". */
const boatCloudWakingAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

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
  const waking = boatCloudWakingAtom(input.environmentId);
  appAtomRegistry.set(waking, true);
  const wake = (async () => {
    const woken = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.wakeBoatCloud,
      {
        environmentId: input.holderEnvironmentId,
        input: {
          environmentId: input.environmentId,
          ...(input.httpBaseUrl ? { httpBaseUrl: input.httpBaseUrl } : {}),
        },
      },
      { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
    );
    if (woken._tag === "Failure") {
      reportFailure("Could not wake the Boat cloud machine", woken);
      return false;
    }
    // A restored VM has a new address, so pair again rather than wait for the old one.
    const paired = await runAtomCommand(
      appAtomRegistry,
      connectPairing,
      {
        host: woken.value.httpBaseUrl,
        pairingCode: woken.value.pairingCode,
        expectedEnvironmentId: woken.value.environmentId,
      },
      { label: connectPairing.label, reportFailure: false, reportDefect: true },
    );
    if (paired._tag === "Failure") {
      reportFailure("Could not reconnect to Boat cloud", paired);
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
    wakesInFlight.delete(input.environmentId);
    appAtomRegistry.set(waking, false);
  });
  wakesInFlight.set(input.environmentId, wake);
  return wake;
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
  const waking = useAtomValue(boatCloudWakingAtom(environmentId));
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
