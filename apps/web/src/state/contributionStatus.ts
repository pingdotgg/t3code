import { useAtomValue } from "@effect/atom-react";
import { createContributionStatusEnvironmentAtoms } from "@t3tools/client-runtime/state/contribution-status";
import type { ContributionStatusEntry, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

const contributionStatusEnvironment = createContributionStatusEnvironmentAtoms(
  connectionAtomRuntime,
  { configValueAtom: serverEnvironment.configValueAtom },
);

/** A thread's advisory statuses, empty when its server lacks the capability. */
export function useThreadContributionStatus(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<ContributionStatusEntry> {
  return useAtomValue(contributionStatusEnvironment.threadStatus(environmentId, threadId));
}
