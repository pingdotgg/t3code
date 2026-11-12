import { useAtomValue } from "@effect/atom-react";
import { visibleLinkedThreads } from "@t3tools/client-runtime/state/threads";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../../components/ui/Dialog";
import { useNavigationState, useRoute } from "@react-navigation/native";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  ThreadId,
  type PullRequestDetail,
  type PullRequestLinkedThreadsResult,
  type PullRequestReviewPosition,
  type ReviewCommentContextRecord,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { normalizeThreadPullRequestKey } from "@t3tools/client-runtime/thread-pull-requests";
import { useRef, useState } from "react";

import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import {
  pendingReviewCommentComposerContext,
  pullRequestComposerContext,
} from "../../lib/composerContext";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { showComposerInsertNotice } from "./composer-insert-notice";
import { reviewPositionLabel } from "./pullRequestDiffComments";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import {
  appendPullRequestAgentPrompt,
  pullRequestAgentPrompt,
  type PullRequestAgentTask,
} from "./pullRequestAgentTasks";

type LinkedThread = PullRequestLinkedThreadsResult["threads"][number];
type DraftKey = Parameters<typeof getComposerDraftSnapshot>[0];

const TOO_MUCH_CONTEXT = "Remove some context from this thread's draft, then try again.";

function pullRequestMetadata(pr: PullRequestDetail) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    state: pr.state,
    isDraft: pr.isDraft,
  };
}

function appendContext(draftKey: DraftKey, record: ReviewCommentContextRecord) {
  const draft = getComposerDraftSnapshot(draftKey);
  return insertComposerDraftContext(
    draftKey,
    {
      text: `${formatComposerContextReference(record)} `,
      context: { version: 1, records: [record] },
    },
    { text: draft.text, start: draft.text.length, end: draft.text.length },
  );
}

/** The pull request is attached once per draft; false when the draft already holds too much context. */
function attachPullRequestContext(
  draftKey: DraftKey,
  pr: PullRequestDetail,
  filePath: string | undefined,
) {
  const context = pullRequestComposerContext(pullRequestMetadata(pr), uuidv4(), filePath);
  const attached = getComposerDraftSnapshot(draftKey).context?.records.some(
    (record) =>
      record.kind === "review-comment" &&
      "pullRequest" in record &&
      record.pullRequest?.url === pr.url &&
      record.filePath === context.filePath,
  );
  return attached || appendContext(draftKey, context);
}

function reviewPositionLine(position: PullRequestReviewPosition) {
  return "newLine" in position ? position.newLine : position.oldLine;
}

export function pendingCommentComposerContext(
  pr: PullRequestDetail,
  comment: {
    readonly path: string;
    readonly body: string;
    readonly code?: string;
    readonly position: PullRequestReviewPosition;
    readonly startPosition?: PullRequestReviewPosition;
  },
) {
  return pendingReviewCommentComposerContext(
    pullRequestMetadata(pr),
    {
      path: comment.path,
      body: comment.body,
      ...(comment.code === undefined ? {} : { code: comment.code }),
      rangeLabel: reviewPositionLabel(comment.position, comment.startPosition),
      startLine: reviewPositionLine(comment.startPosition ?? comment.position),
      endLine: reviewPositionLine(comment.position),
    },
    uuidv4(),
  );
}

export function usePullRequestThreads(
  params: PullRequestParams,
  pr: PullRequestDetail | null,
  filePath?: string,
) {
  const target = pullRequestTarget(params);
  const config = useEnvironmentServerConfig(target.environmentId);
  const supported = threadPullRequestLinkMode(config?.environment.capabilities) === "multiple";
  const parsed = pr ? sourceControlClients.parseChangeRequestUrl(pr.url)?.link : undefined;
  const reference = {
    ...target,
    input: { ...target.input, ...(parsed ? normalizeThreadPullRequestKey(parsed) : {}) },
  };
  const key = JSON.stringify(reference);
  const route = useRoute();
  // The iOS synthetic workspace parent's focus differs from the visible detail's focus.
  const focused = useNavigationState((state) => state.routes[state.index]?.key === route.key);
  // The thread this pull request was opened over, if any: "Add to composer" writes into its draft.
  const threadBehind = useNavigationState((state) => {
    const index = state.routes.findIndex((candidate) => candidate.key === route.key);
    for (let position = index - 1; position >= 0; position -= 1) {
      const candidate = state.routes[position];
      const routeParams = candidate?.params as
        | { readonly environmentId?: unknown; readonly threadId?: unknown }
        | undefined;
      if (
        candidate?.name === "Thread" &&
        typeof routeParams?.threadId === "string" &&
        routeParams.environmentId === params.environmentId
      )
        return routeParams.threadId;
    }
    return null;
  });
  const relations = useEnvironmentQuery(
    pr && supported && focused ? composerPullRequests.linkedThreads(reference) : null,
  );
  const [lastRelations, setLastRelations] = useState({ key, data: relations.data });
  if (relations.data && (lastRelations.key !== key || relations.data !== lastRelations.data))
    setLastRelations({ key, data: relations.data });
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const hidingAnywhere = useAtomValue(environmentThreadShells.anyEnvironmentHidingAtom);
  const loadedThreadRefs = useAtomValue(
    environmentThreadShells.environmentThreadRefsAtom(target.environmentId),
  );
  const threads = visibleLinkedThreads(
    (relations.data ?? (lastRelations.key === key ? lastRelations.data : null))?.threads ?? [],
    target.environmentId,
    loadedThreadRefs,
    hiddenKeys,
    hidingAnywhere,
  );
  const connected = usePullRequestConnected(params.environmentId);
  const canOperate = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const canAsk = !connected || canOperate;
  const canCheckout = useEnvironmentScope(target.environmentId, AuthSourceControlWriteScope);
  const openDetail = useOpenWorkspaceDetail();
  const pending = useRef(false);
  const previousPrompts = useRef(new Map<string, string>());
  const openThread = (thread: LinkedThread) => {
    openThreadRoute({ environmentId: params.environmentId, threadId: thread.id });
  };
  const openThreadRoute = (destination: ReactNavigation.RootParamList["Thread"]) =>
    openDetail({ name: "Thread", params: destination });
  const [busy, setBusy] = useState(false);
  const ask = async (
    thread?: LinkedThread,
    task: PullRequestAgentTask = "ask",
    commentMarkdown?: string,
  ) => {
    if (!pr || !canAsk || pending.current) return;
    const terminology = sourceControlClients.get(pr.provider).changeRequest;
    pending.current = true;
    setBusy(true);
    const result = await settlePromise(async () => {
      if (connected && !thread && !canCheckout)
        throw new Error(
          `Starting work from this ${terminology.shortLabel} requires source control write access.`,
        );
      await waitForComposerDraftsLoaded();
      const draftKey = thread
        ? scopedThreadKey(target.environmentId, ThreadId.make(thread.id))
        : createNewTaskDraft({
            environmentId: target.environmentId,
            projectId: target.input.projectId,
          });
      if (!thread)
        updateComposerDraftSettings(draftKey, {
          workspaceSelection: {
            mode: "worktree",
            branch: pr.headBranch,
            worktreePath: null,
            startFromOrigin: false,
            pullRequestReference: pr.url,
          },
        });
      if (!attachPullRequestContext(draftKey, pr, filePath)) throw new Error(TOO_MUCH_CONTEXT);
      const withContext = getComposerDraftSnapshot(draftKey);
      setComposerDraftText(
        draftKey,
        appendPullRequestAgentPrompt(
          commentMarkdown
            ? `${withContext.text.trimEnd()}\n\n${commentMarkdown}`
            : withContext.text,
          task,
          terminology,
          previousPrompts.current.get(draftKey),
        ),
      );
      previousPrompts.current.set(draftKey, pullRequestAgentPrompt(task, terminology));
      if (thread) openThread(thread);
      else openThreadRoute({ draft: { draftId: draftKey, title: `Ask about #${pr.number}` } });
    });
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert("Couldn't open a thread", cause instanceof Error ? cause.message : "Try again.");
    }
  };
  const canAddToComposer = threadBehind !== null && canAsk;
  /** Desktop's "Add to composer": into the thread behind this pull request, without leaving it. */
  const addToComposer = async (input: {
    readonly markdown?: string;
    readonly context?: ReviewCommentContextRecord;
    readonly filePath?: string;
  }) => {
    if (!pr || threadBehind === null || !canAsk || pending.current) return false;
    pending.current = true;
    setBusy(true);
    const draftKey = scopedThreadKey(target.environmentId, ThreadId.make(threadBehind));
    const result = await settlePromise(async () => {
      await waitForComposerDraftsLoaded();
      if (!attachPullRequestContext(draftKey, pr, input.filePath ?? filePath))
        throw new Error(TOO_MUCH_CONTEXT);
      if (input.context && !appendContext(draftKey, input.context))
        throw new Error(TOO_MUCH_CONTEXT);
      if (input.markdown) {
        const draft = getComposerDraftSnapshot(draftKey);
        setComposerDraftText(draftKey, `${draft.text.trimEnd()}\n\n${input.markdown}\n\n`);
      }
    });
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Couldn't add to the composer",
        cause instanceof Error ? cause.message : "Try again.",
      );
      return false;
    }
    showComposerInsertNotice({ environmentId: params.environmentId, threadId: threadBehind });
    return true;
  };
  return {
    ...relations,
    threads,
    canAsk,
    canAddToComposer,
    canWatch: config?.environment.capabilities.threadPullRequestWatch === true,
    busy,
    ask,
    addToComposer,
    openThread,
  };
}
