import {
  workflowReferenceIssue,
  workflowReferenceLabel,
  workflowReferencePullRequest,
  workflowReferenceThreadId,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunSubject } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useWorkflowThreadOpener } from "./WorkflowStepCard";

/** What a subject is called in one line: its label, then its title when that says more. */
export function workflowSubjectLine(subject: WorkflowRunSubject): string {
  const label = workflowReferenceLabel(subject);
  return subject.title === "" || subject.title === label ? label : `${label} ${subject.title}`;
}

/** Opens a run's subject on its own screen, or its web address. Null when it has neither. */
export function useWorkflowSubjectOpener(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const threadOpener = useWorkflowThreadOpener(environmentId, (thread) =>
    navigation.dispatch(StackActions.push("Thread", thread)),
  );
  return (subject: WorkflowRunSubject): (() => void) | null => {
    const issue = workflowReferenceIssue(subject);
    if (issue !== null) {
      return () =>
        navigation.dispatch(
          StackActions.push("Issue", {
            environmentId,
            projectId: issue.projectId,
            tracker: issue.tracker,
            ...(issue.host === undefined ? {} : { host: issue.host }),
            scope: issue.scope,
            issueKey: issue.key,
          }),
        );
    }
    const pullRequest = workflowReferencePullRequest(subject);
    if (pullRequest !== null) {
      return () =>
        navigation.dispatch(
          StackActions.push("PullRequest", {
            environmentId,
            projectId: pullRequest.projectId,
            repository: pullRequest.repository,
            number: pullRequest.number,
            ...(pullRequest.host === undefined ? {} : { host: pullRequest.host }),
          }),
        );
    }
    const threadId = workflowReferenceThreadId(subject);
    if (threadId !== null) return threadOpener({ threadId, environmentId: null });
    const url = subject.url;
    return url === null ? null : () => void tryOpenExternalUrl(url);
  };
}
