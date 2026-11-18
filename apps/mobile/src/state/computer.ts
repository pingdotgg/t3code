import { useAtomValue } from "@effect/atom-react";
import {
  computerThreadApprovals,
  computerThreadTask,
  createComputerEnvironmentAtoms,
  EMPTY_COMPUTER_SNAPSHOT,
  nextComputerApprovalDeadline,
} from "@t3tools/client-runtime/state/computer";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthComputerApproveScope,
  type ComputerHostView,
  type ComputerSnapshot,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentScope } from "./session";

export const computerEnvironment = createComputerEnvironmentAtoms(connectionAtomRuntime);

/**
 * A server without computer use is skipped instead of subscribed: an older server has no computer
 * RPC to answer. Its tasks and taps then read as none.
 */
const EMPTY_STATE_ATOM = Atom.make(AsyncResult.initial<ComputerSnapshot, never>(false)).pipe(
  Atom.withLabel("mobile-computer-state:empty"),
);

function useComputerUseSupported(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentPresentations.serverConfigsAtom,
    (configs) =>
      environmentId !== null &&
      configs.get(environmentId)?.environment.capabilities.computerUse === true,
  );
}

function useComputerStateAtom(environmentId: EnvironmentId) {
  const supported = useComputerUseSupported(environmentId);
  return supported ? computerEnvironment.state({ environmentId, input: {} }) : EMPTY_STATE_ATOM;
}

function snapshotOf(result: AsyncResult.AsyncResult<ComputerSnapshot, unknown>): ComputerSnapshot {
  return Option.getOrUndefined(AsyncResult.value(result)) ?? EMPTY_COMPUTER_SNAPSHOT;
}

/** Everything one environment's computer use shows, or an empty snapshot without the capability. */
export function useComputerSnapshot(environmentId: EnvironmentId | null): ComputerSnapshot {
  const supported = useComputerUseSupported(environmentId);
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? computerEnvironment.state({ environmentId, input: {} })
      : null,
  );
  return query.data ?? EMPTY_COMPUTER_SNAPSHOT;
}

/** The task this thread started that is still running, for its floating control. */
export const threadComputerTask = computerThreadTask;

/** Whether this thread waits for a tap, so its thread-list row says Approval. */
export function useThreadComputerApproval(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  const atom = useComputerStateAtom(environmentId);
  return useAtomValue(
    atom,
    (result) => computerThreadApprovals(snapshotOf(result), threadId, Date.now()).length > 0,
  );
}

/** When the next pending approval lapses, so a screen re-reads the clock once at that moment. */
export const nextComputerDeadline = nextComputerApprovalDeadline;

/** The taps still answerable, for one thread. */
export const threadComputerApprovals = computerThreadApprovals;

/** Whether this connection may answer an approval: `computer:approve`, which a re-pair grants. */
export function useCanApproveComputerSteps(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentScope(environmentId, AuthComputerApproveScope);
}

/** Every connected computer, labelled with the environment that offers it, for Settings. */
export interface ComputerHostEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly host: ComputerHostView;
}

const EMPTY_HOSTS: ReadonlyArray<ComputerHostEntry> = [];

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
}).pipe(Atom.withLabel("mobile-computer-hosts"));

export function useComputerHosts(): ReadonlyArray<ComputerHostEntry> {
  return useAtomValue(computerHostsAtom);
}

/**
 * Stops one task. Resolves to null on success, or the sentence to show when the request failed.
 */
export async function stopComputerTask(input: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
}): Promise<string | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    computerEnvironment.stop,
    { environmentId: input.environmentId, input: { taskId: input.taskId } },
    { reportFailure: false },
  );
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "Could not stop computer use.";
}
