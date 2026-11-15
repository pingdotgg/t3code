import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BOAT_CLOUD_START_STEPS,
  type BoatCloudSession,
  type BoatCloudStartStep,
  type BoatCloudStatus,
  type BoatCloudStepProgress,
  type EnvironmentId,
  isBoatCloudHttpBaseUrl,
} from "@t3tools/contracts";
import { boatCloudProviderDrivers } from "@t3tools/shared/boatCloudVm";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { connectPairingCode } from "../../connection/onboarding";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import {
  ensurePhoneBoatCloudLoaded,
  phoneBoatCloudAtom,
  startOnPhone,
  wakeOnPhone,
} from "./phoneBoatCloud";

/**
 * Boat cloud VMs are ordinary environments. A holder of the Boat key hands out
 * a VM, and this app pairs with it like any other machine. The holder is a
 * connected machine when one has the key, else this phone.
 */

const PROJECT_APPEAR_TIMEOUT_MS = 60_000;

interface BoatCloudHolder {
  readonly environmentId: EnvironmentId;
  readonly status: BoatCloudStatus;
}

/** Who starts a VM: a connected machine with the key, or this phone with its own. */
type BoatCloudStarter =
  | { readonly kind: "machine"; readonly environmentId: EnvironmentId }
  | { readonly kind: "phone" };

/** Paired Boat VMs, by environment, with the URL each one is reached at. */
export const boatCloudMachinesAtom = Atom.make((get) => {
  const machines = new Map<EnvironmentId, string>();
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    const url = connectionCatalogDisplayUrl(presentation.entry);
    if (url !== null && isBoatCloudHttpBaseUrl(url)) machines.set(environmentId, url);
  }
  return machines;
}).pipe(Atom.withLabel("mobile-boat-cloud:machines"));

/** Connected machines that answer for Boat cloud, without the VMs, which answer too. */
export const boatCloudHoldersAtom = Atom.make((get): ReadonlyArray<BoatCloudHolder> => {
  const machines = get(boatCloudMachinesAtom);
  return get(connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    if (machines.has(environmentId)) return [];
    const status = AsyncResult.getOrElse(
      get(serverEnvironment.boatCloudStatus({ environmentId, input: {} })),
      () => null,
    );
    return status ? [{ environmentId, status }] : [];
  });
}).pipe(Atom.withLabel("mobile-boat-cloud:holders"));

function boatCloudReady(status: BoatCloudStatus | null | undefined) {
  return status?.connected === true && status.setup.status === "ready";
}

/**
 * The holder that should start a VM: the draft's own machine when it can, then
 * any ready machine, which keeps session backups, then this phone.
 */
function boatCloudStarterFor(
  holders: ReadonlyArray<BoatCloudHolder>,
  phone: BoatCloudStatus,
  preferredEnvironmentId: EnvironmentId | null,
): BoatCloudStarter | null {
  const ready = holders.filter((holder) => boatCloudReady(holder.status));
  const machine =
    ready.find((holder) => holder.environmentId === preferredEnvironmentId) ?? ready[0];
  if (machine) return { kind: "machine", environmentId: machine.environmentId };
  return boatCloudReady(phone) ? { kind: "phone" } : null;
}

export function useBoatCloudStarter(preferredEnvironmentId: EnvironmentId | null) {
  const holders = useAtomValue(boatCloudHoldersAtom);
  const phone = useAtomValue(phoneBoatCloudAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this phone's Boat key from the keychain once per launch
  useEffect(() => {
    void ensurePhoneBoatCloudLoaded();
  }, []);
  return boatCloudStarterFor(holders, phone, preferredEnvironmentId);
}

/** The providers a new VM from this starter has sign-ins for, or null when unknown. */
export function useBoatCloudProviderDrivers(preferredEnvironmentId: EnvironmentId | null) {
  const holders = useAtomValue(boatCloudHoldersAtom);
  const phone = useAtomValue(phoneBoatCloudAtom);
  const starter = boatCloudStarterFor(holders, phone, preferredEnvironmentId);
  const status =
    starter?.kind === "machine"
      ? holders.find((holder) => holder.environmentId === starter.environmentId)?.status
      : starter?.kind === "phone"
        ? phone
        : null;
  const chosen = status?.environments.find(
    (environment) => environment.name === status.environment,
  );
  return chosen?.agentCredentials ? boatCloudProviderDrivers(chosen.agentCredentials) : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "An error occurred.";
}

/** Pairs this app with the VM unless it is already connected. Throws what failed. */
async function attach(
  session: Pick<BoatCloudSession, "environmentId" | "httpBaseUrl" | "pairingCode">,
) {
  if (appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(session.environmentId)) return;
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairingCode,
    {
      host: session.httpBaseUrl,
      pairingCode: session.pairingCode,
      expectedEnvironmentId: session.environmentId,
    },
    { label: connectPairingCode.label, reportFailure: false, reportDefect: true },
  );
  if (paired._tag === "Failure") throw squashAtomCommandFailure(paired);
}

function waitForProject(
  find: (projects: ReadonlyArray<EnvironmentProject>) => EnvironmentProject | undefined,
): Promise<EnvironmentProject | null> {
  const atom = environmentProjects.projectsAtom;
  const now = find(appAtomRegistry.get(atom));
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = (project: EnvironmentProject | null) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(project);
    };
    const timeout = setTimeout(() => finish(null), PROJECT_APPEAR_TIMEOUT_MS);
    const unsubscribe = appAtomRegistry.subscribe(atom, (projects) => {
      const project = find(projects);
      if (project) finish(project);
    });
  });
}

const cancelled = new Error("Boat cloud start cancelled");

const HOLDER_STEPS = new Set<BoatCloudStartStep>(["machine", "server", "repository"]);

const pendingBoatCloudSteps = (): ReadonlyArray<BoatCloudStepProgress> =>
  BOAT_CLOUD_START_STEPS.map((step) => ({ step, state: "pending", detail: null }));

/** Starts the VM through a connected machine, following its steps in that machine's status. */
async function startOnMachine(
  environmentId: EnvironmentId,
  repositoryUrl: string,
  baseBranch: string | null,
  onHolderSteps: (steps: ReadonlyArray<BoatCloudStepProgress>) => void,
): Promise<BoatCloudSession> {
  const requestId = uuidv4();
  const statusAtom = serverEnvironment.boatCloudStatus({ environmentId, input: {} });
  const unsubscribe = appAtomRegistry.subscribe(statusAtom, (result) => {
    const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (start) onHolderSteps(start.steps.filter((step) => HOLDER_STEPS.has(step.step)));
  });
  try {
    const acquired = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.acquireBoatCloud,
      {
        environmentId,
        input: { repositoryUrl, ...(baseBranch ? { baseBranch } : {}), requestId },
      },
      { label: serverEnvironment.acquireBoatCloud.label, reportFailure: false, reportDefect: true },
    );
    if (acquired._tag === "Failure") {
      throw isAtomCommandInterrupted(acquired) ? cancelled : squashAtomCommandFailure(acquired);
    }
    return acquired.value;
  } finally {
    unsubscribe();
  }
}

/**
 * Gets a VM with the repository checked out and returns its project there, so
 * a draft can move onto it, reporting every step on the way. The caller marks
 * the last step, moving the thread, done. Null after telling the user what failed.
 */
export async function prepareBoatCloudProject(input: {
  readonly starter: BoatCloudStarter;
  readonly repositoryUrl: string;
  readonly baseBranch: string | null;
  readonly onProgress: (steps: ReadonlyArray<BoatCloudStepProgress>) => void;
}): Promise<EnvironmentProject | null> {
  let steps = pendingBoatCloudSteps();
  const set = (step: BoatCloudStartStep, patch: Partial<BoatCloudStepProgress>) => {
    steps = steps.map((entry) => (entry.step === step ? { ...entry, ...patch } : entry));
    input.onProgress(steps);
  };
  const setHolderSteps = (holderSteps: ReadonlyArray<BoatCloudStepProgress>) => {
    for (const entry of holderSteps) set(entry.step, entry);
  };
  let current: BoatCloudStartStep = "machine";
  try {
    const session =
      input.starter.kind === "machine"
        ? await startOnMachine(
            input.starter.environmentId,
            input.repositoryUrl,
            input.baseBranch,
            setHolderSteps,
          )
        : await startOnPhone({
            repositoryUrl: input.repositoryUrl,
            baseBranch: input.baseBranch,
            report: (step, state, detail) => Effect.sync(() => set(step, { state, detail })),
          });
    for (const step of HOLDER_STEPS) set(step, { state: "done" });
    current = "connect";
    set("connect", { state: "active" });
    await attach(session);
    set("connect", { state: "done" });
    current = "project";
    set("project", { state: "active" });
    const project = await waitForProject((projects) =>
      projects.find(
        (candidate) =>
          candidate.environmentId === session.environmentId &&
          candidate.workspaceRoot === session.workspaceRoot,
      ),
    );
    if (!project) throw new Error("The Boat cloud machine did not open the project.");
    set("project", { state: "done" });
    set("thread", { state: "active" });
    return project;
  } catch (error) {
    const failed = steps.find((entry) => entry.state === "active")?.step ?? current;
    set(failed, { state: "failed" });
    if (error !== cancelled) Dialog.alert("Could not start on Boat cloud", errorMessage(error));
    return null;
  }
}

const wakesInFlight = new Map<EnvironmentId, Promise<void>>();

/** Whether this app is turning a VM back on, so its thread shows "Waking" rather than "Sleeping". */
const boatCloudWakingAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

/**
 * Turns a stopped VM back on. A machine that owns it can also restore it from
 * its backup and hands out a new pairing; the phone reconnects to the same server.
 */
function wakeBoatCloudMachine(environmentId: EnvironmentId, httpBaseUrl: string): Promise<void> {
  const inFlight = wakesInFlight.get(environmentId);
  if (inFlight) return inFlight;
  const waking = boatCloudWakingAtom(environmentId);
  appAtomRegistry.set(waking, true);
  const wake = (async () => {
    await ensurePhoneBoatCloudLoaded();
    const holders = appAtomRegistry.get(boatCloudHoldersAtom);
    const phoneHasKey = appAtomRegistry.get(phoneBoatCloudAtom).connected;
    // The machine that started the VM can restore it; any other machine with the key can wake it.
    const owner =
      holders.find((holder) =>
        holder.status.machines.some((machine) => machine.environmentId === environmentId),
      ) ?? (phoneHasKey ? undefined : holders.find((holder) => holder.status.connected));
    if (owner) {
      const woken = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.wakeBoatCloud,
        { environmentId: owner.environmentId, input: { environmentId, httpBaseUrl } },
        { label: serverEnvironment.wakeBoatCloud.label, reportFailure: false, reportDefect: true },
      );
      if (woken._tag === "Failure") {
        if (!isAtomCommandInterrupted(woken)) {
          Dialog.alert(
            "Could not wake the Boat cloud machine",
            errorMessage(squashAtomCommandFailure(woken)),
          );
        }
        return;
      }
      // A restored VM has a new address, so pair again rather than wait for the old one.
      await attach(woken.value).catch((error: unknown) =>
        Dialog.alert("Could not reconnect to Boat cloud", errorMessage(error)),
      );
      return;
    }
    if (!phoneHasKey) return;
    await wakeOnPhone(httpBaseUrl).catch((error: unknown) =>
      Dialog.alert("Could not wake the Boat cloud machine", errorMessage(error)),
    );
  })().finally(() => {
    wakesInFlight.delete(environmentId);
    appAtomRegistry.set(waking, false);
  });
  wakesInFlight.set(environmentId, wake);
  return wake;
}

export interface BoatCloudSleep {
  readonly state: "sleeping" | "waking";
  readonly wake: () => void;
}

/**
 * A Boat VM that is not reachable is asleep: it stopped itself after its threads
 * went quiet. A message sent meanwhile waits in the queue and wakes it, so its
 * thread reads "Sleeping" rather than disconnected.
 */
export function useBoatCloudSleep(
  environmentId: EnvironmentId | null,
  phase: EnvironmentConnectionPhase | null,
): BoatCloudSleep | null {
  const machines = useAtomValue(boatCloudMachinesAtom);
  const waking = useAtomValue(boatCloudWakingAtom(environmentId));
  const httpBaseUrl = environmentId === null ? null : (machines.get(environmentId) ?? null);
  if (environmentId === null || httpBaseUrl === null || phase === null || phase === "connected") {
    return null;
  }
  // Retries cycle the phase, so only this app's own wake reads as waking.
  return {
    state: waking ? "waking" : "sleeping",
    wake: () => void wakeBoatCloudMachine(environmentId, httpBaseUrl),
  };
}
