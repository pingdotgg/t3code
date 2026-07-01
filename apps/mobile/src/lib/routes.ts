import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { AppNavigation } from "../navigation/app-navigation";
import type { AppNavigationTarget } from "../navigation/route-model";
import type { SelectedThreadRef } from "../state/remote-runtime-types";

type Navigation = AppNavigation;

type ThreadRouteInput =
  | Pick<SelectedThreadRef, "environmentId" | "threadId">
  | Pick<EnvironmentThreadShell, "environmentId" | "id">;
type PlainThreadRouteInput =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
    }
  | {
      environmentId: EnvironmentId;
      id: ThreadId;
    };

export function buildThreadRoutePath(input: ThreadRouteInput | PlainThreadRouteInput): string {
  const environmentId = input.environmentId;
  const threadId = "threadId" in input ? input.threadId : input.id;

  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export function homeNavigation(): AppNavigationTarget {
  return { name: "Home" };
}

export function settingsNavigation(): AppNavigationTarget {
  return { name: "Settings" };
}

export function settingsEnvironmentsNavigation(): AppNavigationTarget {
  return { name: "SettingsEnvironments" };
}

export function settingsEnvironmentNewNavigation(): AppNavigationTarget {
  return { name: "SettingsEnvironmentNew" };
}

export function settingsAuthNavigation(): AppNavigationTarget {
  return { name: "SettingsAuth" };
}

export function settingsArchiveNavigation(): AppNavigationTarget {
  return { name: "SettingsArchive" };
}

export function settingsWaitlistNavigation(): AppNavigationTarget {
  return { name: "SettingsWaitlist" };
}

export function connectionsNavigation(): AppNavigationTarget {
  return { name: "Connections" };
}

export function connectionsNewNavigation(): AppNavigationTarget {
  return { name: "ConnectionsNew" };
}

export function newTaskNavigation(): AppNavigationTarget {
  return { name: "NewTask" };
}

export function addProjectNavigation(): AppNavigationTarget {
  return { name: "AddProject" };
}

export function addProjectRepositoryNavigation(params: {
  readonly environmentId?: string;
  readonly source?: string;
}): AppNavigationTarget {
  return { name: "AddProjectRepository", params };
}

export function addProjectLocalNavigation(params: {
  readonly environmentId?: string;
}): AppNavigationTarget {
  return { name: "AddProjectLocal", params };
}

export function addProjectDestinationNavigation(params: {
  readonly environmentId?: string;
  readonly source?: string;
  readonly remoteUrl?: string;
  readonly repositoryTitle?: string;
}): AppNavigationTarget {
  return { name: "AddProjectDestination", params };
}

export function newTaskDraftNavigation(params: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
}): AppNavigationTarget {
  return { name: "NewTaskDraft", params };
}

export function threadNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
): AppNavigationTarget {
  return {
    name: "Thread",
    params: threadRouteParams(input),
  };
}

export function buildThreadReviewRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
): string {
  return `${buildThreadRoutePath(input)}/review`;
}

export function buildThreadReviewNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
): AppNavigationTarget {
  return {
    name: "ThreadReview",
    params: threadRouteParams(input),
  };
}

export function buildThreadReviewCommentNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
): AppNavigationTarget {
  return {
    name: "ThreadReviewComment",
    params: threadRouteParams(input),
  };
}

export function buildGitOverviewNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
): AppNavigationTarget {
  return {
    name: "GitOverview",
    params: threadRouteParams(input),
  };
}

export function buildGitCommitNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
): AppNavigationTarget {
  return {
    name: "GitCommit",
    params: threadRouteParams(input),
  };
}

export function buildGitBranchesNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
): AppNavigationTarget {
  return {
    name: "GitBranches",
    params: threadRouteParams(input),
  };
}

export function buildGitConfirmNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
  params: {
    readonly confirmAction: string;
    readonly branchName: string;
    readonly includesCommit: string;
  },
): AppNavigationTarget {
  return {
    name: "GitConfirm",
    params: {
      ...threadRouteParams(input),
      ...params,
    },
  };
}

export function buildThreadFilesRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
  relativePath?: string | null,
  line?: number | null,
): string {
  const basePath = `${buildThreadRoutePath(input)}/files`;
  if (!relativePath) {
    return basePath;
  }

  const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (pathSegments.length === 0) {
    return basePath;
  }

  const encodedPath = pathSegments.map(encodeURIComponent).join("/");
  const lineParam =
    Number.isFinite(line) && Number(line) > 0 ? `?line=${Math.floor(Number(line))}` : "";
  return `${basePath}/${encodedPath}${lineParam}`;
}

export function buildThreadTerminalRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
  terminalId?: string | null,
): string {
  const basePath = `${buildThreadRoutePath(input)}/terminal`;
  if (!terminalId) {
    return basePath;
  }

  return `${basePath}?terminalId=${encodeURIComponent(terminalId)}`;
}

export function buildThreadTerminalNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
  terminalId?: string | null,
): AppNavigationTarget {
  const environmentId = String(input.environmentId);
  const threadId = String("threadId" in input ? input.threadId : input.id);

  const params: { environmentId: string; threadId: string; terminalId?: string } = {
    environmentId,
    threadId,
  };

  if (terminalId != null && terminalId !== "") {
    params.terminalId = terminalId;
  }

  return {
    name: "ThreadTerminal",
    params,
  };
}

export function buildThreadFilesNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
  relativePath?: string | null,
  line?: number | null,
): AppNavigationTarget {
  const environmentId = String(input.environmentId);
  const threadId = String("threadId" in input ? input.threadId : input.id);
  const path = relativePath?.split("/").filter((segment) => segment.length > 0) ?? [];

  if (path.length === 0) {
    return {
      name: "ThreadFiles",
      params: { environmentId, threadId },
    };
  }

  const params: {
    environmentId: string;
    threadId: string;
    path: string[];
    line?: string;
  } = { environmentId, threadId, path };
  if (Number.isFinite(line) && Number(line) > 0) {
    params.line = String(Math.floor(Number(line)));
  }

  return {
    name: "ThreadFile",
    params,
  };
}

export function dismissRoute(navigation: Navigation) {
  if (navigation.canGoBack()) {
    navigation.back();
    return;
  }

  navigation.replace(homeNavigation());
}

function threadRouteParams(input: ThreadRouteInput | PlainThreadRouteInput): {
  readonly environmentId: string;
  readonly threadId: string;
} {
  return {
    environmentId: String(input.environmentId),
    threadId: String("threadId" in input ? input.threadId : input.id),
  };
}
