import { useAtomValue } from "@effect/atom-react";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOAT_CLOUD_START_STEPS,
  type BoatCloudAcquireInput,
  type BoatCloudSession,
  type BoatCloudStartStep,
  type BoatCloudStepProgress,
  type BoxdCloudStatus,
  type EnvironmentId,
  isBoatCloudHttpBaseUrl,
  isBoxdCloudHttpBaseUrl,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { connectPairingCode } from "../../connection/onboarding";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import type { BoatCloudTarget } from "../boatCloud/boatCloud";

/**
 * boxd cloud machines are ordinary environments, like Boat VMs. A connected machine holding
 * the boxd key hands one out and this app pairs with it. The phone never holds a boxd key.
 */

const PROJECT_APPEAR_TIMEOUT_MS = 60_000;
const RECONNECT_TIMEOUT_MS = 15_000;
const HOLDER_STEPS = new Set<BoatCloudStartStep>(["machine", "server", "repository"]);

/** Paired boxd machines, by environment, with the URL each one is reached at. */
export const boxdCloudMachinesAtom = Atom.make((get) => {
  const machines = new Map<EnvironmentId, string>();
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    const url = connectionCatalogDisplayUrl(presentation.entry);
    if (url !== null && isBoxdCloudHttpBaseUrl(url)) machines.set(environmentId, url);
  }
  return machines;
}).pipe(Atom.withLabel("mobile-boxd-cloud:machines"));

export function boxdCloudReady(status: BoxdCloudStatus | null | undefined) {
  return status?.connected === true && (status.setup.status === "ready" || status.snapshotReady);
}

/** Connected machines that answer for boxd cloud, without the boxd machines themselves. */
export const boxdCloudHoldersAtom = Atom.make((get) => {
  const machines = get(boxdCloudMachinesAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  return get(connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    // Boat VMs answer for boxd cloud too, but must never get the key.
    const presentation = presentations.get(environmentId);
    const url = presentation ? connectionCatalogDisplayUrl(presentation.entry) : null;
    if (machines.has(environmentId) || (url !== null && isBoatCloudHttpBaseUrl(url))) return [];
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.boxdCloud !== true) return [];
    const status = AsyncResult.getOrElse(
      get(serverEnvironment.boxdCloudStatus({ environmentId, input: {} })),
      () => null,
    );
    return status ? [{ environmentId, status }] : [];
  });
}).pipe(Atom.withLabel("mobile-boxd-cloud:holders"));

/** The machine that should start a boxd machine: the draft's own when it can, else any ready one. */
export function useBoxdCloudStarter(preferredEnvironmentId: EnvironmentId | null) {
  const ready = useAtomValue(boxdCloudHoldersAtom).filter((holder) =>
    boxdCloudReady(holder.status),
  );
  const holder =
    ready.find((candidate) => candidate.environmentId === preferredEnvironmentId) ?? ready[0];
  return holder?.environmentId ?? null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "An error occurred.";
}

function waitFor<T>(
  atom: Atom.Atom<T>,
  find: (value: T) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (find(appAtomRegistry.get(atom))) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = appAtomRegistry.subscribe(atom, (value) => {
      if (find(value)) finish(true);
    });
  });
}

/** Connects this app to the machine, by its saved credential or by pairing. Throws what failed. */
async function attach(session: BoatCloudSession) {
  const isConnected = (ids: ReadonlyArray<EnvironmentId>) => ids.includes(session.environmentId);
  if (isConnected(appAtomRegistry.get(connectedEnvironmentIdsAtom))) return;
  if (session.pairingCode === null) {
    // An asleep machine left its connection backing off; connecting is what wakes it.
    void environmentCatalog.retryNow.run(appAtomRegistry, session.environmentId);
    if (!(await waitFor(connectedEnvironmentIdsAtom, isConnected, RECONNECT_TIMEOUT_MS))) {
      throw new Error("Could not reconnect to the boxd machine.");
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

const cancelled = new Error("boxd cloud start cancelled");

/**
 * Gets a boxd machine with the repository checked out and returns its project there, so a
 * draft can move onto it, reporting every step on the way. Null after telling the user why.
 */
export async function prepareBoxdCloudProject(input: {
  readonly holderEnvironmentId: EnvironmentId;
  readonly repositoryUrl: string;
  readonly baseBranch: string | null;
  readonly onProgress: (steps: ReadonlyArray<BoatCloudStepProgress>) => void;
}): Promise<BoatCloudTarget | null> {
  let steps: ReadonlyArray<BoatCloudStepProgress> = BOAT_CLOUD_START_STEPS.map((step) => ({
    step,
    state: "pending",
    detail: null,
  }));
  const set = (step: BoatCloudStartStep, patch: Partial<BoatCloudStepProgress>) => {
    steps = steps.map((entry) => (entry.step === step ? { ...entry, ...patch } : entry));
    input.onProgress(steps);
  };
  let checkoutFailed: (error: Error) => void = () => undefined;
  const watchCheckout = () =>
    new Promise<never>((_, reject) => {
      checkoutFailed = reject;
    });
  let checkoutFailure = watchCheckout();
  let requestId = uuidv4();
  const stopWatching = appAtomRegistry.subscribe(
    serverEnvironment.boxdCloudStatus({ environmentId: input.holderEnvironmentId, input: {} }),
    (result) => {
      const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
        (candidate) => candidate.requestId === requestId,
      );
      for (const entry of start?.steps ?? []) {
        if (!HOLDER_STEPS.has(entry.step)) continue;
        set(entry.step, entry);
        if (entry.step === "repository" && entry.state === "failed") {
          checkoutFailed(new Error(entry.detail ?? "Could not get the repository on the machine."));
        }
      }
    },
  );
  const acquire = async (paired: BoatCloudAcquireInput["paired"]) => {
    const acquired = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.acquireBoxdCloud,
      {
        environmentId: input.holderEnvironmentId,
        input: {
          repositoryUrl: input.repositoryUrl,
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
          requestId,
          paired,
        },
      },
      { label: serverEnvironment.acquireBoxdCloud.label, reportFailure: false, reportDefect: true },
    );
    if (acquired._tag === "Failure") {
      throw isAtomCommandInterrupted(acquired) ? cancelled : squashAtomCommandFailure(acquired);
    }
    return acquired.value;
  };
  let current: BoatCloudStartStep = "machine";
  try {
    const paired = [...appAtomRegistry.get(boxdCloudMachinesAtom)].map(
      ([environmentId, httpBaseUrl]) => ({ environmentId, httpBaseUrl }),
    );
    let session = await acquire(paired);
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
      // The saved credential no longer works, so start once more and pair as a new app.
      requestId = uuidv4();
      checkoutFailure = watchCheckout();
      session = await acquire([]);
      await attach(session);
    }
    set("connect", { state: "done" });
    current = "project";
    const projectArrived = await Promise.race([
      waitFor(
        environmentProjects.projectsAtom,
        (projects) =>
          projects.some(
            (candidate) =>
              candidate.environmentId === session.environmentId &&
              candidate.workspaceRoot === session.workspaceRoot,
          ),
        PROJECT_APPEAR_TIMEOUT_MS,
      ),
      checkoutFailure,
    ]);
    const project = appAtomRegistry
      .get(environmentProjects.projectsAtom)
      .find(
        (candidate) =>
          candidate.environmentId === session.environmentId &&
          candidate.workspaceRoot === session.workspaceRoot,
      );
    if (!projectArrived || !project) throw new Error("The boxd machine did not open the project.");
    set("repository", { state: "done" });
    set("project", { state: "done" });
    set("thread", { state: "active" });
    return { project, worktree: session.worktree ?? null };
  } catch (error) {
    if (!steps.some((entry) => entry.state === "failed")) set(current, { state: "failed" });
    if (error !== cancelled) Dialog.alert("Could not start on boxd cloud", errorMessage(error));
    return null;
  } finally {
    stopWatching();
  }
}
