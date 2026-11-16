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
  type BoatCloudAcquireInput,
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
import { environmentCatalog } from "../../connection/catalog";
import { connectPairingCode } from "../../connection/onboarding";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { boxdCloudMachinesAtom } from "../boxdCloud/boxdCloud";
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
const RECONNECT_TIMEOUT_MS = 15_000;

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

/** Boat VMs and boxd machines, which answer for Boat cloud too but must never get the key. */
const cloudMachineIdsAtom = Atom.make(
  (get) => new Set([...get(boatCloudMachinesAtom).keys(), ...get(boxdCloudMachinesAtom).keys()]),
).pipe(Atom.withLabel("mobile-boat-cloud:cloud-machine-ids"));

/** Connected machines whose T3 Code predates Boat cloud, so they cannot take the key yet. */
export const boatCloudOutdatedMachinesAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const cloudMachines = get(cloudMachineIdsAtom);
  return get(connectedEnvironmentIdsAtom).filter((environmentId) => {
    if (cloudMachines.has(environmentId)) return false;
    const config = get(serverEnvironment.configValueAtom(environmentId));
    return config !== null && config.environment.capabilities.boatCloud !== true;
  });
}).pipe(Atom.withLabel("mobile-boat-cloud:outdated-machines"));

/** Connected machines that answer for Boat cloud, without the cloud machines, which answer too. */
export const boatCloudHoldersAtom = Atom.make((get): ReadonlyArray<BoatCloudHolder> => {
  const cloudMachines = get(cloudMachineIdsAtom);
  return get(connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    if (cloudMachines.has(environmentId)) return [];
    const status = AsyncResult.getOrElse(
      get(serverEnvironment.boatCloudStatus({ environmentId, input: {} })),
      () => null,
    );
    return status ? [{ environmentId, status }] : [];
  });
}).pipe(Atom.withLabel("mobile-boat-cloud:holders"));

function boatCloudReady(status: BoatCloudStatus | null | undefined) {
  return status?.connected === true && (status.setup.status === "ready" || status.snapshotReady);
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

/** Paired VMs as the holder takes them, so it skips their pairing code. */
const pairedBoatCloudEnvironments = (): NonNullable<BoatCloudAcquireInput["paired"]> =>
  [...appAtomRegistry.get(boatCloudMachinesAtom)].map(([environmentId, httpBaseUrl]) => ({
    environmentId,
    httpBaseUrl,
  }));

const reconnectFailed = new Error("Could not reconnect to the Boat cloud machine.");

/** Resolves once the environment is connected, or false after `timeoutMs`. */
function waitForConnected(environmentId: EnvironmentId, timeoutMs: number): Promise<boolean> {
  const connected = () => appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(environmentId);
  if (connected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = appAtomRegistry.subscribe(connectedEnvironmentIdsAtom, () => {
      if (connected()) finish(true);
    });
  });
}

/**
 * Connects this app to the VM: with its saved credential when the holder sent no
 * pairing code, else by pairing. Throws what failed.
 */
async function attach(
  session: Pick<BoatCloudSession, "environmentId" | "httpBaseUrl" | "pairingCode">,
) {
  if (appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(session.environmentId)) return;
  if (session.pairingCode === null) {
    // A stopped VM left its connection backing off; retry now that the server is up.
    void environmentCatalog.retryNow.run(appAtomRegistry, session.environmentId);
    if (!(await waitForConnected(session.environmentId, RECONNECT_TIMEOUT_MS))) {
      throw reconnectFailed;
    }
    return;
  }
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

/**
 * Starts the VM through a connected machine. Its steps arrive in that machine's
 * status, the checkout's after the acquire returns, so the caller stops watching.
 */
function startOnMachine(input: {
  readonly environmentId: EnvironmentId;
  readonly repositoryUrl: string;
  readonly baseBranch: string | null;
  readonly paired: BoatCloudAcquireInput["paired"];
  readonly onHolderSteps: (steps: ReadonlyArray<BoatCloudStepProgress>) => void;
}) {
  const requestId = uuidv4();
  const statusAtom = serverEnvironment.boatCloudStatus({
    environmentId: input.environmentId,
    input: {},
  });
  const stopWatching = appAtomRegistry.subscribe(statusAtom, (result) => {
    const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (start) input.onHolderSteps(start.steps.filter((step) => HOLDER_STEPS.has(step.step)));
  });
  const session = runAtomCommand(
    appAtomRegistry,
    serverEnvironment.acquireBoatCloud,
    {
      environmentId: input.environmentId,
      input: {
        repositoryUrl: input.repositoryUrl,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        requestId,
        paired: input.paired,
      },
    },
    { label: serverEnvironment.acquireBoatCloud.label, reportFailure: false, reportDefect: true },
  ).then((acquired): BoatCloudSession => {
    if (acquired._tag === "Failure") {
      throw isAtomCommandInterrupted(acquired) ? cancelled : squashAtomCommandFailure(acquired);
    }
    return acquired.value;
  });
  return { session, stopWatching };
}

/** The VM's project for a draft, and the worktree the VM made for its thread, when it made one. */
export interface BoatCloudTarget {
  readonly project: EnvironmentProject;
  readonly worktree: BoatCloudSession["worktree"] | null;
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
}): Promise<BoatCloudTarget | null> {
  let steps = pendingBoatCloudSteps();
  const set = (step: BoatCloudStartStep, patch: Partial<BoatCloudStepProgress>) => {
    steps = steps.map((entry) => (entry.step === step ? { ...entry, ...patch } : entry));
    input.onProgress(steps);
  };
  // The checkout keeps running after the acquire returns, and only its step says how it ended.
  let checkoutFailed: (error: Error) => void = () => undefined;
  const watchCheckout = () =>
    new Promise<never>((_, reject) => {
      checkoutFailed = reject;
    });
  let checkoutFailure = watchCheckout();
  const setHolderStep = (step: BoatCloudStartStep, patch: Partial<BoatCloudStepProgress>) => {
    set(step, patch);
    if (step === "repository" && patch.state === "failed") {
      checkoutFailed(new Error(patch.detail ?? "Could not get the repository on the VM."));
    }
  };
  const setHolderSteps = (holderSteps: ReadonlyArray<BoatCloudStepProgress>) => {
    for (const entry of holderSteps) setHolderStep(entry.step, entry);
  };
  const stops: Array<() => void> = [];
  // A start that was retried keeps reporting, so only the latest one's steps count.
  let attempt = 0;
  const start = (paired: BoatCloudAcquireInput["paired"]) => {
    attempt += 1;
    const mine = attempt;
    if (input.starter.kind === "phone") {
      return startOnPhone({
        repositoryUrl: input.repositoryUrl,
        baseBranch: input.baseBranch,
        paired,
        report: (step, state, detail) =>
          Effect.sync(() => {
            if (mine === attempt) setHolderStep(step, { state, detail });
          }),
      });
    }
    const started = startOnMachine({
      environmentId: input.starter.environmentId,
      repositoryUrl: input.repositoryUrl,
      baseBranch: input.baseBranch,
      paired,
      onHolderSteps: (holderSteps) => {
        if (mine === attempt) setHolderSteps(holderSteps);
      },
    });
    stops.push(started.stopWatching);
    return started.session;
  };
  let current: BoatCloudStartStep = "machine";
  try {
    let session = await start(pairedBoatCloudEnvironments());
    // The VM and its server are up; the checkout may still run while this app connects.
    set("machine", { state: "done" });
    set("server", { state: "done" });
    if (steps.find((entry) => entry.step === "repository")?.state === "pending") {
      set("repository", { state: "active" });
    }
    current = "connect";
    set("connect", { state: "active" });
    try {
      await attach(session);
    } catch {
      // The saved credential no longer works, or the VM did not answer, so start once more
      // and pair as a new app. A VM that does not answer gets no new thread.
      checkoutFailure = watchCheckout();
      session = await start([]);
      await attach(session);
    }
    set("connect", { state: "done" });
    current = "project";
    const project = await Promise.race([
      waitForProject((projects) =>
        projects.find(
          (candidate) =>
            candidate.environmentId === session.environmentId &&
            candidate.workspaceRoot === session.workspaceRoot,
        ),
      ),
      checkoutFailure,
    ]);
    if (!project) throw new Error("The Boat cloud machine did not open the project.");
    // The project is added after the checkout and its worktree, so it appearing means both are done.
    set("repository", { state: "done" });
    set("project", { state: "done" });
    set("thread", { state: "active" });
    return { project, worktree: session.worktree ?? null };
  } catch (error) {
    if (!steps.some((entry) => entry.state === "failed")) {
      set(current, { state: "failed" });
    }
    if (error !== cancelled) Dialog.alert("Could not start on Boat cloud", errorMessage(error));
    return null;
  } finally {
    for (const stop of stops) stop();
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

const WAKE_CONNECT_TIMEOUT_MS = 90_000;

/**
 * Wakes a Boat VM that is not connected before an action runs on it. False when it
 * could not be woken; true when it is connected or is not a Boat VM at all.
 */
export async function wakeBoatCloudIfAsleep(environmentId: EnvironmentId): Promise<boolean> {
  if (appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(environmentId)) return true;
  const httpBaseUrl = appAtomRegistry.get(boatCloudMachinesAtom).get(environmentId);
  if (httpBaseUrl === undefined) return true;
  await wakeBoatCloudMachine(environmentId, httpBaseUrl);
  return waitForConnected(environmentId, WAKE_CONNECT_TIMEOUT_MS);
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
