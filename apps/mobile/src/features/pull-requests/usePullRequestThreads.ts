import { useNavigation, useNavigationState, useRoute } from "@react-navigation/native";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  ThreadId,
  type PullRequestDetail,
  type PullRequestLinkedThreadsResult,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import { useRef, useState } from "react";
import { Alert, Platform } from "react-native";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
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

/** Stay in the PR's environment when entering a thread or creating its draft. */
export function usePullRequestThreads(
  params: PullRequestParams,
  pr: PullRequestDetail | null,
  filePath?: string,
) {
  const target = pullRequestTarget(params);
  const config = useEnvironmentServerConfig(target.environmentId);
  const supported = threadPullRequestLinkMode(config?.environment.capabilities) === "multiple";
  const parsed = pr ? parseChangeRequestUrl(pr.url) : null;
  const reference = {
    ...target,
    input: { ...target.input, ...(parsed ? normalizeThreadPullRequestKey(parsed) : {}) },
  };
  const key = JSON.stringify(reference);
  const route = useRoute();
  // The iOS split host projects detail screens beneath a synthetic workspace
  // route. Its parent's focus flag is not the visible detail's focus flag.
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
  // Composing offline only writes a local draft. The outbox checks grants on delivery.
  const canAsk = !connected || canOperate;
  const canCheckout = useEnvironmentScope(target.environmentId, AuthSourceControlWriteScope);
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const pending = useRef(false);
  const previousPrompts = useRef(new Map<string, string>());
  const openThread = (thread: LinkedThread) => {
    const destination = { environmentId: params.environmentId, threadId: thread.id };
    if (Platform.OS === "android") selectAndroidWorkspace({ name: "Thread", params: destination });
    else navigation.navigate("Thread", destination);
  };
  const [busy, setBusy] = useState(false);
  const ask = async (thread?: LinkedThread, task: PullRequestAgentTask = "ask") => {
    if (!pr || !canAsk || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (connected && !thread && !canCheckout)
        throw new Error("Starting work from this PR requires source control write access.");
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
        appendPullRequestAgentPrompt(withContext.text, task, previousPrompts.current.get(draftKey)),
      );
      previousPrompts.current.set(draftKey, pullRequestAgentPrompt(task));
      if (thread) openThread(thread);
      else
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: { draftId: draftKey, title: `Ask about #${pr.number}` },
        });
    } catch (cause) {
      Alert.alert("Couldn't open a thread", cause instanceof Error ? cause.message : "Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
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
