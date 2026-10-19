import {
  checkoutPullRequestUrlToLink,
  type DraftId,
  type DraftSessionState,
  markPromotedDraftThreadByRef,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "../composerDraftStore";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  planThreadPullRequestMutation,
  threadPullRequestLinkMode,
} from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  findProjectForChangeRequest,
  matchesLinkedPullRequestUrl,
  parseChangeRequestUrl,
  type ChangeRequestLink,
} from "~/lib/openPullRequestLink";
import { useEffect } from "react";
import { resolveLiveThreadBranchUpdate } from "~/components/GitActionsControl.logic";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/** Keep checkout ownership fixed once the first send is dispatched. */
export async function startTurnWithCheckoutLink<A, E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly draftId: DraftId | null;
  readonly draft: DraftSessionState | null;
  readonly start: () => Promise<AtomCommandResult<A, E>>;
  readonly link: (threadRef: ScopedThreadRef, url: string, linked: boolean) => Promise<void>;
}): Promise<AtomCommandResult<A, E>> {
  const { draftId, draft } = input;
  if (!draftId || !draft) return input.start();
  const url = checkoutPullRequestUrlToLink(draft);
  markPromotedDraftThreadByRef(input.threadRef);
  const result = await input.start();
  if (result._tag === "Failure") {
    const current = useComposerDraftStore.getState().getDraftSession(draftId) ?? draft;
    restoreFailedBackgroundDraftThread(draftId, current, current.threadId);
  } else if (url) {
    void Promise.resolve()
      .then(() => input.link(input.threadRef, url, true))
      .catch((error: unknown) => {
        console.warn("Failed to link the checked-out pull request to its thread.", error);
      });
  }
  return result;
}

export function canLinkChangeRequest(
  mode: ReturnType<typeof threadPullRequestLinkMode>,
  projects: ReadonlyArray<EnvironmentProject>,
  parsed: ChangeRequestLink,
): boolean {
  if (mode === "unsupported") return false;
  if (mode === "multiple") return true;
  return findProjectForChangeRequest(projects, parsed) !== undefined;
}

// A string, so provider status pushes and snapshots that keep the mode don't
// re-render every link renderer.
const linkModeAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    threadPullRequestLinkMode(
      environmentId === null
        ? undefined
        : get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities,
    ),
  ).pipe(Atom.withLabel("pull-request-link-mode")),
);

export function usePullRequestLinking(
  environmentId: EnvironmentId | null | undefined,
  checkoutDraft?: {
    draftId: DraftId;
    draft: DraftSessionState;
    gitStatus: VcsStatusResult | null;
    isGitActionRunning: boolean;
  },
) {
  const { draftId, draft, gitStatus, isGitActionRunning } = checkoutDraft ?? {};
  useEffect(() => {
    if (!draftId || !draft?.checkoutPullRequest || draft.promotedTo || isGitActionRunning) return;
    const store = useComposerDraftStore.getState();
    if (store.getDraftSession(draftId) !== draft) return;
    const checkout = draft.checkoutPullRequest;
    // Cached status can still name the branch from before checkout.
    if (!checkout.branchConfirmed) {
      if (gitStatus?.refName === checkout.branch) {
        store.setDraftThreadContext(draftId, {
          checkoutPullRequest: { ...checkout, branchConfirmed: true },
        });
      }
      return;
    }
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: draft.branch,
      gitStatus: gitStatus ?? null,
    });
    if (update) store.setDraftThreadContext(draftId, update);
  }, [draftId, draft, gitStatus, isGitActionRunning]);

  const projects = useProjects();
  const mode = useAtomValue(linkModeAtom(environmentId ?? null));
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const canLink = (url: string) => {
    const parsed = parseChangeRequestUrl(url);
    return parsed !== null && canLinkChangeRequest(mode, environmentProjects, parsed);
  };
  const isLinked = (
    thread: {
      readonly pullRequests?: readonly ThreadPullRequestLink[];
      readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
    } | null,
    url: string,
  ) => {
    if (thread === null || mode === "unsupported") return false;
    if (mode !== "multiple")
      return (
        thread.linkedPullRequest != null &&
        matchesLinkedPullRequestUrl(thread.linkedPullRequest, url)
      );
    const parsed = parseChangeRequestUrl(url);
    return (
      parsed !== null &&
      visibleThreadPullRequests(thread.pullRequests ?? []).some((entry) =>
        threadPullRequestKeysEqual(entry, parsed),
      )
    );
  };
  const changeLink = async (threadRef: ScopedThreadRef, url: string, linked: boolean) => {
    const parsed = parseChangeRequestUrl(url);
    if (parsed === null || threadRef.environmentId !== environmentId || (linked && !canLink(url)))
      throw new Error("The pull request is not available in this environment.");
    const legacyProject = findProjectForChangeRequest(environmentProjects, parsed);
    const mutation = planThreadPullRequestMutation({
      capabilities: appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId)
        ?.environment.capabilities,
      threadId: threadRef.threadId,
      reference: { ...parsed, url },
      legacyProjectId: legacyProject?.id ?? null,
      legacyRepository:
        sourceControlRepositorySelector(legacyProject?.repositoryIdentity) ?? undefined,
      linked,
    });
    if (mutation === null)
      throw new Error("This environment does not support linking this pull request.");
    const result = await (mutation.type === "thread.meta.update"
      ? updateMetadata({ environmentId: threadRef.environmentId, input: mutation.input })
      : mutation.type === "thread.pull-request.link"
        ? link({ environmentId: threadRef.environmentId, input: mutation.input })
        : unlink({ environmentId: threadRef.environmentId, input: mutation.input }));
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
      throw squashAtomCommandFailure(result);
    }
  };
  return { mode, canLink, isLinked, changeLink };
}
