import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../../components/ui/Dialog";
import {
  StackActions,
  useNavigation,
  useNavigationState,
  useRoute,
} from "@react-navigation/native";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  ThreadId,
  type PullRequestDetail,
  type PullRequestLinkedThreadsResult,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { normalizeThreadPullRequestKey } from "@t3tools/client-runtime/thread-pull-requests";
import { useRef, useState } from "react";
import { Platform } from "react-native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { pullRequestComposerContext } from "../../lib/composerContext";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import {
  appendPullRequestAgentPrompt,
  pullRequestAgentPrompt,
  type PullRequestAgentTask,
} from "./pullRequestAgentTasks";

type LinkedThread = PullRequestLinkedThreadsResult["threads"][number];

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
  const relations = useEnvironmentQuery(
    pr && supported && focused ? composerPullRequests.linkedThreads(reference) : null,
  );
  const [lastRelations, setLastRelations] = useState({ key, data: relations.data });
  if (relations.data && (lastRelations.key !== key || relations.data !== lastRelations.data))
    setLastRelations({ key, data: relations.data });
  const threads =
    (relations.data ?? (lastRelations.key === key ? lastRelations.data : null))?.threads ?? [];
  const connected = usePullRequestConnected(params.environmentId);
  const canOperate = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const canAsk = !connected || canOperate;
  const canCheckout = useEnvironmentScope(target.environmentId, AuthSourceControlWriteScope);
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const pending = useRef(false);
  const previousPrompts = useRef(new Map<string, string>());
  const openThread = (thread: LinkedThread) => {
    openThreadRoute({ environmentId: params.environmentId, threadId: thread.id });
  };
  // Android shows one page at a time; iOS opens the thread over the pull request, so Back returns.
  const openThreadRoute = (destination: ReactNavigation.RootParamList["Thread"]) => {
    if (Platform.OS === "android") selectDetail({ name: "Thread", params: destination });
    else navigation.dispatch(StackActions.push("Thread", destination));
  };
  const [busy, setBusy] = useState(false);
  const ask = async (thread?: LinkedThread, task: PullRequestAgentTask = "ask") => {
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
      const context = pullRequestComposerContext(
        {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          state: pr.state,
          isDraft: pr.isDraft,
        },
        uuidv4(),
        filePath,
      );
      const draft = getComposerDraftSnapshot(draftKey);
      const attached = draft.context?.records.some(
        (record) =>
          record.kind === "review-comment" &&
          "pullRequest" in record &&
          record.pullRequest?.url === pr.url &&
          record.filePath === context.filePath,
      );
      if (
        !attached &&
        !insertComposerDraftContext(
          draftKey,
          {
            text: `${formatComposerContextReference(context)} `,
            context: { version: 1, records: [context] },
          },
          { text: draft.text, start: draft.text.length, end: draft.text.length },
        )
      )
        throw new Error("Remove some context from this thread's draft, then try again.");
      const withContext = getComposerDraftSnapshot(draftKey);
      setComposerDraftText(
        draftKey,
        appendPullRequestAgentPrompt(
          withContext.text,
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
  return {
    ...relations,
    threads,
    canAsk,
    canWatch: config?.environment.capabilities.threadPullRequestWatch === true,
    busy,
    ask,
    openThread,
  };
}
