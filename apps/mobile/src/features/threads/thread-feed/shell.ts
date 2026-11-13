/**
 * Helpers that wait for a linked thread's shell before navigating.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthFilesystemReadScope,
  idleCompactionOf,
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../../state/threads";
import { waitForThreadShellReady } from "../threadForkNavigation";

export async function waitForThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
  });
}
