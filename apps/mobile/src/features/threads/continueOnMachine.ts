import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  threadRuntimeIsActive,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, PeerLinkSummary, ThreadId, VcsStatusResult } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

/**
 * Whether "Continue on another machine" shows for a thread, and whether it can run now. It is
 * hidden for threads with no project or no Git remote, and while the environment does not offer
 * linked environments. It is shown but disabled while a run is active.
 */
export function continueOnMachineAvailability(input: {
  readonly project: Pick<EnvironmentProject, "isScratch" | "repositoryIdentity"> | null;
  /** From `offersLinkedEnvironments` for the thread's environment. */
  readonly linkedEnvironmentsOffered: boolean;
  readonly runtime: EnvironmentThreadShell["runtime"];
}) {
  const hasRemote =
    input.project !== null &&
    input.project.isScratch !== true &&
    input.project.repositoryIdentity != null;
  if (!hasRemote || !input.linkedEnvironmentsOffered) return "hidden";
  return threadRuntimeIsActive(input.runtime) ? "busy" : "ready";
}

/** Why a linked machine cannot receive the thread, or null when it can. */
export type ContinueTargetBlock = "access" | "expired" | "unreachable";

/**
 * The linked machines in pick order. Only a reachable link with Full access can receive a thread;
 * the others stay listed with the reason they cannot.
 */
export function continueTargets(links: ReadonlyArray<PeerLinkSummary>, now: DateTime.Utc) {
  return links.map((link) => {
    const health = peerLinkHealth(link, now).kind;
    const block: ContinueTargetBlock | null =
      link.access !== "full-access"
        ? "access"
        : health === "expired"
          ? "expired"
          : health === "unreachable"
            ? "unreachable"
            : null;
    return { environmentId: link.environmentId, label: link.label, link, block };
  });
}

/** The work on this machine that only moves after a commit and push. */
export function unpushedWork(
  status: Pick<VcsStatusResult, "hasWorkingTreeChanges" | "hasUpstream" | "aheadCount">,
) {
  return {
    uncommittedChanges: status.hasWorkingTreeChanges,
    unpushedCommits: status.hasUpstream ? status.aheadCount : 0,
    branchNotPushed: !status.hasUpstream,
  };
}

export type UnpushedWork = ReturnType<typeof unpushedWork>;

export function hasUnpushedWork(work: UnpushedWork) {
  return work.uncommittedChanges || work.unpushedCommits > 0 || work.branchNotPushed;
}

/** The request for `threadEnvironment.continueOnEnvironment`; a blank message is left out. */
export function continueOnMachineInput(input: {
  readonly threadId: ThreadId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly commitAndPush: boolean;
  readonly message: string;
}) {
  const message = input.message.trim();
  return {
    threadId: input.threadId,
    targetEnvironmentId: input.targetEnvironmentId,
    commitAndPush: input.commitAndPush,
    ...(message === "" ? {} : { message }),
  };
}
