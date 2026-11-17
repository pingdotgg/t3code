import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  type BoatCloudAcquireInput,
  type BoatCloudSession,
  type BoatCloudStartStep,
  type BoxdCloudStatus,
  type EnvironmentId,
  isBoxdCloudHttpBaseUrl,
} from "@t3tools/contracts";
import { parseRepository } from "@t3tools/shared/boatCloudVm";
import { AsyncResult } from "effect/reactivity";

import { type BoatCloudTarget, boatCloudStartProgressAtom } from "./boatCloud";
import {
  type BoatCloudStartProgress,
  completeStep,
  failProgress,
  markAcquired,
  startingProgress,
  withHolderSteps,
} from "./boatCloudStart.logic";
import type { DraftId } from "./composerDraftStore";
import { environmentCatalog } from "./connection/catalog";
import { connectPairing } from "./connection/onboarding";
import { randomUUID } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "./state/environments";
import { environmentPresentations, environmentSummaries } from "./state/presentation";
import { environmentSession, sessionHasScope } from "./state/session";
import { environmentProjects } from "./state/projects";
import { useEnvironmentQuery } from "./state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "./state/server";
import { waitForAtomValue } from "./state/waitForAtomValue";

/**
 * boxd cloud machines are ordinary environments, like Boat cloud VMs: this machine holds the
 * boxd key and hands out a machine, and the client pairs with it. Starts show in the same
 * progress as Boat's, so the composer and thread render them the same way.
 */

const PROJECT_APPEAR_TIMEOUT_MS = 60_000;
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;
const RECONNECT_TIMEOUT_MS = 15_000;

/** An environment's boxd cloud status, while it is connected and its T3 Code knows boxd. */
function useBoxdCloudStatus(environmentId: EnvironmentId | null): BoxdCloudStatus | null {
  const connected = useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return useEnvironmentQuery(
    environmentId !== null &&
      connected.includes(environmentId) &&
      config?.environment.capabilities.boxdCloud === true
      ? serverEnvironment.boxdCloudStatus({ environmentId, input: {} })
      : null,
  ).data;
}

/** The status of this machine, which hands out boxd machines for the threads started here. */
export function usePrimaryBoxdCloudStatus() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return {
    holderEnvironmentId: primaryEnvironmentId,
    status: useBoxdCloudStatus(primaryEnvironmentId),
  };
}

export function boxdCloudReady(status: BoxdCloudStatus | null) {
  return status?.connected === true && (status.setup.status === "ready" || status.snapshotReady);
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

function updateProgress(
  draftId: DraftId,
  update: (progress: BoatCloudStartProgress) => BoatCloudStartProgress,
) {
  const atom = boatCloudStartProgressAtom(draftId);
  const current = appAtomRegistry.get(atom);
  if (current) appAtomRegistry.set(atom, update(current));
}

/** Ends the draft's start, once its thread is created or it leaves boxd cloud. */
export function clearBoxdCloudStartProgress(draftId: DraftId) {
  prewarmed.delete(draftId);
  appAtomRegistry.set(boatCloudStartProgressAtom(draftId), null);
}

/** boxd machines this client already paired with, so the holder skips their pairing code. */
function pairedBoxdCloudEnvironments(): NonNullable<BoatCloudAcquireInput["paired"]> {
  const paired: Array<{ environmentId: EnvironmentId; httpBaseUrl: string }> = [];
  for (const [environmentId, presentation] of appAtomRegistry.get(
    environmentPresentations.presentationsAtom,
  )) {
    const httpBaseUrl = connectionCatalogDisplayUrl(presentation.entry);
    if (httpBaseUrl !== null && isBoxdCloudHttpBaseUrl(httpBaseUrl)) {
      paired.push({ environmentId, httpBaseUrl });
    }
  }
  return paired;
}

/** Connects this client to the machine, by its saved credential or by pairing. Returns the failure. */
async function attach(session: BoatCloudSession): Promise<string | null> {
  const connected = appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom);
  if (connected.includes(session.environmentId)) return null;
  if (session.pairingCode === null) {
    // An asleep machine left its connection backing off; connecting now is what wakes it.
    void environmentCatalog.retryNow.run(appAtomRegistry, session.environmentId);
    const reconnected = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentSummaries.connectedEnvironmentIdsAtom,
      predicate: (ids) => ids.includes(session.environmentId),
      timeoutMs: RECONNECT_TIMEOUT_MS,
    });
    return reconnected ? null : "Could not reconnect to the machine.";
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

interface BoxdCloudPrepareInput {
  readonly draftId: DraftId;
  readonly holderEnvironmentId: EnvironmentId;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
}

/**
 * Gets a boxd machine with the repository checked out and returns its project there, so the
 * draft can move onto it and send. A warm spare comes back at once and wakes as this client
 * connects, so pairing, the checkout and the project's arrival run alongside each other.
 */
async function prepareBoxdCloudProjectNow(
  input: BoxdCloudPrepareInput,
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
  const startedAt = performance.now();
  const endedAtMs: Record<string, number> = {};
  const markEnded = (step: string) => {
    endedAtMs[step] = Math.round(performance.now() - startedAt);
  };
  const logTiming = (outcome: "ready" | "failed") =>
    console.info("[boxd-cloud] start timing", {
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
    serverEnvironment.boxdCloudStatus({ environmentId: input.holderEnvironmentId, input: {} }),
    (result) => {
      const start = AsyncResult.getOrElse(result, () => null)?.starts.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (!start) return;
      updateProgress(draftId, (progress) => withHolderSteps(progress, start.steps));
      const repository = start.steps.find((entry) => entry.step === "repository");
      if (repository?.state === "failed") {
        repositoryFailed(repository.detail ?? "Could not get the repository on the machine.");
      }
      if (repository?.state === "done") repositoryDone();
    },
  );
  try {
    const acquire = (paired: BoatCloudAcquireInput["paired"]) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.acquireBoxdCloud,
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
          label: serverEnvironment.acquireBoxdCloud.label,
          reportFailure: false,
          reportDefect: true,
        },
      );
    let acquired = await acquire(pairedBoxdCloudEnvironments());
    if (acquired._tag === "Failure") {
      if (isAtomCommandInterrupted(acquired)) {
        clearBoxdCloudStartProgress(draftId);
        return null;
      }
      return fail(failureMessage(acquired));
    }
    updateProgress(draftId, markAcquired);
    markEnded("acquire");
    let attachFailure = await attach(acquired.value);
    if (attachFailure !== null) {
      // The saved credential no longer works, so start once more and pair as a new client.
      requestId = randomUUID();
      checkout = watchCheckout();
      acquired = await acquire([]);
      if (acquired._tag === "Failure") {
        if (isAtomCommandInterrupted(acquired)) {
          clearBoxdCloudStartProgress(draftId);
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

    // The send needs the machine's project, server config and operate grant, and a thread that
    // takes the machine's worktree waits for the holder to say it is cut.
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
    if (arrived.includes(false) || !project) return fail("The machine did not open the project.");
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

const prewarmed = new Map<
  DraftId,
  { readonly repositoryUrl: string; readonly target: Promise<BoatCloudTarget | null> }
>();

/** Starts getting a machine as soon as the draft picks boxd cloud; the send reuses it. */
export function prewarmBoxdCloudProject(input: BoxdCloudPrepareInput) {
  if (prewarmed.get(input.draftId)?.repositoryUrl === input.repositoryUrl) return;
  prewarmed.set(input.draftId, {
    repositoryUrl: input.repositoryUrl,
    target: prepareBoxdCloudProjectNow(input),
  });
}

/** The draft's pre-warmed start when it is for this repository and did not fail, else a new one. */
export async function prepareBoxdCloudProject(
  input: BoxdCloudPrepareInput,
): Promise<BoatCloudTarget | null> {
  const started = prewarmed.get(input.draftId);
  prewarmed.delete(input.draftId);
  if (started?.repositoryUrl === input.repositoryUrl) {
    const target = await started.target;
    if (target !== null) return target;
  }
  return prepareBoxdCloudProjectNow(input);
}
