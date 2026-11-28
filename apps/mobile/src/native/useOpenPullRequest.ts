import { useNavigation, useRoute, StackActions } from "@react-navigation/native";
import { isStandaloneIssueLink, resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import {
  nativePullRequestDestination,
  pullRequestCandidateForIssueLink,
} from "../lib/pullRequestNavigation";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useProjects, useThreadShell } from "../state/entities";
import { tryOpenWebLink } from "../lib/openExternalUrl";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentServerConfigsAtom } from "../state/server";
import { issueTrackerEnvironment } from "../state/issueTrackers";
import { composerPullRequests } from "../state/pull-requests";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { withKnownPullRequestSummary } from "../state/use-thread-pr";

let linkNavigationId = 0;
const nextLinkNavigationId = () => ++linkNavigationId;

type PullRequestContext = { readonly environmentId: string; readonly projectId: string };

// Avoid useRoute so layouts without route context can open any thread's pull requests.
export function useNavigateToPullRequest(options?: { readonly replace?: boolean }) {
  const navigation = useNavigation();
  const projects = useProjects();
  const replace = options?.replace;
  const readPreview = useAtomQueryRunner(composerPullRequests.preview, {
    reportFailure: false,
    reportDefect: false,
  });
  const readTrackerConnections = useAtomQueryRunner(issueTrackerEnvironment.connections, {
    reportFailure: false,
    reportDefect: false,
  });
  return async (url: string, context: PullRequestContext | null) => {
    // Read at press time so a config push does not hand every link a new handler.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const destination = nativePullRequestDestination(url, context, projects, (environmentId) =>
      serverConfigs.has(environmentId),
    );
    if (!destination) {
      // An issue link from the same text opens the issue; anything else leaves for the browser.
      const environmentId = context && EnvironmentId.make(context.environmentId);
      const issuesEnabled =
        environmentId !== null &&
        serverConfigs.get(environmentId)?.environment.capabilities.issues === true;
      // Only a standalone tracker's link needs the bindings, whose read probes the tracker.
      const connections =
        issuesEnabled && isStandaloneIssueLink(url)
          ? await readTrackerConnections({ environmentId, input: {} })
          : null;
      const issue =
        issuesEnabled && context !== null
          ? resolveIssueLinkTarget({
              url,
              projects: projects.filter((project) => project.environmentId === environmentId),
              preferredProjectId: context.projectId,
              trackers: connections?._tag === "Success" ? connections.value : undefined,
            })
          : null;
      if (!issue || !environmentId) return tryOpenWebLink(url, "pull-request");
      const candidate = pullRequestCandidateForIssueLink(url, issue.ref);
      if (candidate) {
        const preview = await readPreview({ environmentId, input: candidate.target });
        if (preview._tag === "Success") {
          const params = withKnownPullRequestSummary({
            ...candidate.target,
            environmentId,
            ...(candidate.navigationUrl
              ? { navigationUrl: candidate.navigationUrl, navigationId: nextLinkNavigationId() }
              : {}),
          });
          if (replace) navigation.dispatch(StackActions.replace("PullRequest", params));
          else navigation.dispatch(StackActions.push("PullRequest", params));
          return true;
        }
        // A dropped connection says nothing about what the link names; the browser knows.
        if (isAtomCommandInterrupted(preview)) return tryOpenWebLink(url, "pull-request");
      }
      const issueParams = {
        environmentId,
        projectId: issue.ref.projectId,
        tracker: issue.ref.tracker,
        ...(issue.ref.host === undefined ? {} : { host: issue.ref.host }),
        scope: issue.ref.scope,
        issueKey: issue.ref.key,
      };
      if (replace) navigation.dispatch(StackActions.replace("Issue", issueParams));
      else navigation.dispatch(StackActions.push("Issue", issueParams));
      return true;
    }
    const params = withKnownPullRequestSummary({
      ...destination,
      ...(destination.navigationUrl ? { navigationId: nextLinkNavigationId() } : {}),
    });
    if (replace) navigation.dispatch(StackActions.replace("PullRequest", params));
    else navigation.dispatch(StackActions.push("PullRequest", params));
    return true;
  };
}

export function useOpenPullRequest(options?: {
  readonly replace?: boolean;
  readonly context?: PullRequestContext;
}) {
  const route = useRoute();
  const routeContext = route.params as
    | {
        environmentId?: string | string[];
        projectId?: string | string[];
        threadId?: string | string[];
      }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = first(routeContext?.threadId);
  const thread = useThreadShell(
    environmentId && threadId
      ? { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) }
      : null,
  );
  const projectId =
    options?.context?.projectId ?? first(routeContext?.projectId) ?? thread?.projectId;
  const navigateToPullRequest = useNavigateToPullRequest({ replace: options?.replace });
  return (url: string) =>
    navigateToPullRequest(
      url,
      environmentId && projectId
        ? { environmentId: String(environmentId), projectId: String(projectId) }
        : null,
    );
}
