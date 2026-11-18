import {
  createComputerEnvironmentAtoms,
  EMPTY_COMPUTER_SNAPSHOT,
  nextComputerApprovalDeadline,
} from "@t3tools/client-runtime/state/computer";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthComputerApproveScope,
  type ComputerHostView,
  type ComputerSnapshot,
  type ComputerTaskView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentScope } from "./session";

export const computerEnvironment = createComputerEnvironmentAtoms(connectionAtomRuntime);

/** One running task, with the environment it belongs to, for the global strip. */
export interface ComputerActivityEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly task: ComputerTaskView;
}

/** A computer one environment can use, labelled with the environment that offers it. */
export interface ComputerHostEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly host: ComputerHostView;
}

const EMPTY_ACTIVITY: ReadonlyArray<ComputerActivityEntry> = [];
const EMPTY_HOSTS: ReadonlyArray<ComputerHostEntry> = [];

/**
 * Every environment's running tasks. A server without the capability is skipped instead of
 * subscribed: an older server has no computer RPC to answer.
 */
const computerActivityAtom = Atom.make((get): ReadonlyArray<ComputerActivityEntry> => {
  const entries: ComputerActivityEntry[] = [];
  for (const [environmentId, config] of get(environmentPresentations.serverConfigsAtom)) {
    if (config.environment.capabilities.computerUse !== true) continue;
    const result = get(computerEnvironment.state({ environmentId, input: {} }));
    const snapshot = Option.getOrUndefined(AsyncResult.value(result));
    for (const task of snapshot?.tasks ?? []) {
      if (task.status !== "running") continue;
      entries.push({
        environmentId,
        environmentLabel: config.settings.environmentLabel ?? config.environment.label,
        task,
      });
    }
  }
  return entries.length === 0 ? EMPTY_ACTIVITY : entries;
}).pipe(Atom.withLabel("web-computer-activity"));

export function useComputerActivity(): ReadonlyArray<ComputerActivityEntry> {
  return useAtomValue(computerActivityAtom);
}

/** Every environment's connected computers, for Settings. */
const computerHostsAtom = Atom.make((get): ReadonlyArray<ComputerHostEntry> => {
  const entries: ComputerHostEntry[] = [];
  for (const [environmentId, config] of get(environmentPresentations.serverConfigsAtom)) {
    if (config.environment.capabilities.computerUse !== true) continue;
    const result = get(computerEnvironment.state({ environmentId, input: {} }));
    const snapshot = Option.getOrUndefined(AsyncResult.value(result));
    for (const host of snapshot?.hosts ?? []) {
      entries.push({
        environmentId,
        environmentLabel: config.settings.environmentLabel ?? config.environment.label,
        host,
      });
    }
  }
  return entries.length === 0 ? EMPTY_HOSTS : entries;
}).pipe(Atom.withLabel("web-computer-hosts"));

export function useComputerHosts(): ReadonlyArray<ComputerHostEntry> {
  return useAtomValue(computerHostsAtom);
}

/** The snapshot of one environment, or an empty one where the server has no computer use. */
export function useComputerSnapshot(environmentId: EnvironmentId | null): {
  readonly snapshot: ComputerSnapshot;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const supported = useAtomValue(
    environmentPresentations.serverConfigsAtom,
    (configs) =>
      environmentId !== null &&
      configs.get(environmentId)?.environment.capabilities.computerUse === true,
  );
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? computerEnvironment.state({ environmentId, input: {} })
      : null,
  );
  return {
    snapshot: query.data ?? EMPTY_COMPUTER_SNAPSHOT,
    loaded: query.data !== null,
    error: query.error,
    refresh: query.refresh,
  };
}

/** When something in this snapshot next changes on its own: an approval lapsing. */
export const nextComputerDeadline = nextComputerApprovalDeadline;

/** Whether this connection may answer an approval: `computer:approve`, which a re-pair grants. */
export function useCanApproveComputerSteps(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentScope(environmentId, AuthComputerApproveScope);
}

/**
 * Stops every running task in one environment, or only `taskId`. Resolves to null on success, or
 * the sentence to show when the request failed.
 */
export async function stopComputerTasks(input: {
  readonly environmentId: EnvironmentId;
  readonly taskId?: string;
}): Promise<string | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    computerEnvironment.stop,
    {
      environmentId: input.environmentId,
      input: input.taskId === undefined ? {} : { taskId: input.taskId },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "Could not stop computer use.";
}

/** Stops every running task across connected environments, for the palette and the keybinding. */
export async function stopAllComputerTasks(): Promise<ReadonlyArray<string>> {
  const environmentIds = [
    ...new Set(appAtomRegistry.get(computerActivityAtom).map((entry) => entry.environmentId)),
  ];
  const failures = await Promise.all(
    environmentIds.map((environmentId) => stopComputerTasks({ environmentId })),
  );
  return failures.filter((failure): failure is string => failure !== null);
}
