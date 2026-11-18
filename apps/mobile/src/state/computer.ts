import { useAtomValue } from "@effect/atom-react";
import {
  type ComputerThreadView,
  createComputerEnvironmentAtoms,
  stopComputerTasks,
} from "@t3tools/client-runtime/state/computer";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";

export const computerEnvironment = createComputerEnvironmentAtoms(
  connectionAtomRuntime,
  () => environmentPresentations.serverConfigsAtom,
);

/** One thread's running computer task and pending taps; re-renders only when those change. */
export function useThreadComputer(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ComputerThreadView {
  return useAtomValue(computerEnvironment.thread(environmentId, threadId));
}

const waitsForTap = (view: ComputerThreadView) => view.approvals.length > 0;

/** Whether this thread waits for a tap, so its thread-list row says Approval. */
export function useThreadComputerApproval(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return useAtomValue(computerEnvironment.thread(environmentId, threadId), waitsForTap);
}

/** Whether this connection may answer an approval: `computer:approve`, which a re-pair grants. */
export function useCanApproveComputerSteps(environmentId: EnvironmentId): boolean {
  return useAtomValue(computerEnvironment.respondToApproval.permissionAtom(environmentId));
}

export function useComputerHosts() {
  return useAtomValue(computerEnvironment.hosts);
}

export function stopComputerTask(input: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
}): Promise<string | null> {
  return stopComputerTasks(appAtomRegistry, computerEnvironment, input);
}
