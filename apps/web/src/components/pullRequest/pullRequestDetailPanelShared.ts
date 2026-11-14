import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import {
  type PullRequestAction,
  type PullRequestDetail,
  type PullRequestRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { lazy } from "react";

import { type DraftId } from "~/composerDraftStore";
import { type PullRequestDetailTab } from "~/rightPanelStore";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { toastManager } from "../ui/toast";

import { pullRequestAutolinkPlugins } from "./pullRequestMarkdown.logic";

import { resolvePullRequestReferenceHost } from "./pullRequestDetail.logic";

export const actionFailureLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: `Could not merge this ${term}`,
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: `Could not close this ${term}`,
  reopen: `Could not reopen this ${term}`,
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not turn on auto-merge",
  "disable-auto-merge": "Could not turn off auto-merge",
  revert: `Could not open a revert ${term}`,
  "delete-branch": "Could not delete this branch",
  "approve-workflows": "Could not approve workflows",
});

export const actionFailureHints = (term: string): Record<PullRequestAction, string> => ({
  merge:
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, and that the branch still exists.",
  "update-branch":
    "The host refused it. Check that you have write access to the branch (a fork branch also needs its author to allow edits from maintainers), and that it does not conflict with the base.",
  "enable-auto-merge":
    "The host refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.",
  "disable-auto-merge":
    "The host refused it. Check that you have write access, and that the merge has not already happened.",
  revert: `The host refused it. Check that you have write access and that this ${term} was merged on the host.`,
  "delete-branch":
    "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
  "approve-workflows":
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
});

export const UPDATE_BRANCH_REBASE_FAILURE_HINT =
  "The host refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.";

export const TABS: ReadonlyArray<{ value: PullRequestDetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "guide", label: "Guide" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

// Defer the diff viewer's worker pool until Code is approached.
export const loadCodeTab = () => import("./PullRequestCodeTab");
export const PullRequestCodeTab = lazy(loadCodeTab);

// Persist handoffs across unmounts; replace only unchanged contributions to preserve user edits.
export const lastHandoffPromptByDraft = new Map<string, string>();

export const composerTargetKey = (target: ScopedThreadRef | DraftId): string =>
  typeof target === "string" ? target : scopedThreadKey(target);

export function reportCheckoutCommandError(error: Error) {
  toastManager.add({
    type: "error",
    title: "Could not copy checkout command",
    description: error.message,
  });
}

export function resolvePullRequestReference(
  requestedReference: PullRequestRef,
  repositoryIdentity: Parameters<typeof resolvePullRequestReferenceHost>[1],
  supportsThreadPullRequests: boolean,
): PullRequestRef {
  return supportsThreadPullRequests
    ? resolvePullRequestReferenceHost(requestedReference, repositoryIdentity)
    : {
        projectId: requestedReference.projectId,
        repository: requestedReference.repository,
        number: requestedReference.number,
      };
}

export function pullRequestMarkdownContext(
  detail: Pick<PullRequestDetail, "provider" | "url"> | null,
  threadRef: ScopedThreadRef | null,
) {
  return {
    remarkPlugins: pullRequestAutolinkPlugins(detail),
    lineBreaks: sourceControlClients.find(detail?.provider ?? "")?.hardLineBreaks ?? false,
    threadRef,
  };
}

export function pullRequestStackReference(
  detail: Pick<PullRequestDetail, "url" | "capabilities"> | null,
  reference: PullRequestRef,
  supportsThreadPullRequests: boolean,
) {
  return detail === null || detail.capabilities.stacks !== true || !supportsThreadPullRequests
    ? null
    : {
        ...reference,
        host: reference.host ?? sourceControlClients.parseChangeRequestUrl(detail.url)?.link.host,
      };
}
