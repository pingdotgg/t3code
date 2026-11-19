import {
  type ComputerThreadView,
  createComputerEnvironmentAtoms,
  stopComputerTasks as stopEnvironmentComputerTasks,
} from "@t3tools/client-runtime/state/computer";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";

export const computerEnvironment = createComputerEnvironmentAtoms(
  connectionAtomRuntime,
  () => environmentPresentations.serverConfigsAtom,
);

const NO_THREAD_ATOM = Atom.make<ComputerThreadView>({ task: null, approvals: [] }).pipe(
  Atom.withLabel("web-computer-thread:none"),
);

export function useComputerActivity() {
  return useAtomValue(computerEnvironment.activity);
}

export function useComputerHosts() {
  return useAtomValue(computerEnvironment.hosts);
}

/** One thread's running computer task and pending taps; re-renders only when those change. */
export function useThreadComputer(threadRef: ScopedThreadRef | null): ComputerThreadView {
  return useAtomValue(
    threadRef === null
      ? NO_THREAD_ATOM
      : computerEnvironment.thread(threadRef.environmentId, threadRef.threadId),
  );
}

/** Whether this connection may answer an approval: `computer:approve`, which a re-pair grants. */
export function useCanApproveComputerSteps(environmentId: EnvironmentId): boolean {
  return useAtomValue(computerEnvironment.respondToApproval.permissionAtom(environmentId));
}

export function stopComputerTasks(input: {
  readonly environmentId: EnvironmentId;
  readonly taskId?: string;
}): Promise<string | null> {
  return stopEnvironmentComputerTasks(appAtomRegistry, computerEnvironment, input, m);
}

/** Stops every running task across connected environments, for the palette and the keybinding. */
export async function stopAllComputerTasks(): Promise<ReadonlyArray<string>> {
  const environmentIds = [
    ...new Set(
      appAtomRegistry.get(computerEnvironment.activity).map((entry) => entry.environmentId),
    ),
  ];
  const failures = await Promise.all(
    environmentIds.map((environmentId) => stopComputerTasks({ environmentId })),
  );
  return failures.filter((failure): failure is string => failure !== null);
}
