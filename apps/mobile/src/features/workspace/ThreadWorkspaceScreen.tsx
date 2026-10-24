import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import {
  readWorkspacePane,
  rememberWorkspacePane,
  resolveWorkspacePane,
  rememberThreadWorkspaceLocation,
  readThreadReviewSelection,
  workspaceThreadMemoryKey,
  type WorkspacePane,
} from "./workspacePaneMemory";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { vcsEnvironment } from "../../state/vcs";
import { environmentSession } from "../../state/session";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { ThreadFilesTreeScreen, ThreadFileScreen } from "../files/ThreadFilesRouteScreen";
import { ReviewHeader, ReviewSheet } from "../review/ReviewSheet";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly path?: string[];
  readonly line?: string;
  readonly cwd?: string;
  readonly projectName?: string;
  readonly reviewSectionId?: string;
  readonly reviewFilePath?: string;
  readonly reviewWorkingTreeScope?: "staged" | "unstaged";
}>;

function ThreadWorkspaceScreen(props: Props & { readonly defaultPane?: WorkspacePane }) {
  const navigation = useNavigation();
  const paneKey = workspaceThreadMemoryKey(
    props.route.params.environmentId,
    props.route.params.threadId,
  );
  const [tab, setTab] = useState<WorkspacePane | null>(() =>
    props.route.params.path
      ? "files"
      : props.route.params.reviewSectionId
        ? "git"
        : (props.defaultPane ?? readWorkspacePane(paneKey)),
  );
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThreadCwd: cwd } = useSelectedThreadWorktree();
  const session = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const environment = useEnvironmentPresentation(environmentId);
  const access = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  const status = useEnvironmentQuery(
    access.canReadFiles && cwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd } })
      : null,
  );
  // Status counts each changed path once, including edits that cancel between
  // the index and working tree, and updates through the existing Git subscription.
  const count = status.data?.workingTree?.files.length;
  const statusUnavailable =
    !access.isPending && (!access.canReadFiles || cwd === null || status.error !== null);
  const selectedTab = resolveWorkspacePane(tab, count ?? (statusUnavailable ? 0 : undefined));
  if (selectedTab !== null && selectedTab !== tab) {
    setTab(selectedTab);
    rememberWorkspacePane(paneKey, selectedTab);
  }
  const selectTab = (pane: WorkspacePane) => {
    setTab(pane);
    rememberWorkspacePane(paneKey, pane);
    const params = props.route.params;
    if (pane === "files") {
      rememberThreadWorkspaceLocation({
        name: params.path ? "ThreadFile" : "ThreadFiles",
        params: {
          environmentId: params.environmentId,
          threadId: params.threadId,
          ...(params.path ? { path: params.path } : {}),
          ...(params.line ? { line: params.line } : {}),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.projectName ? { projectName: params.projectName } : {}),
        },
      });
    } else {
      const sectionId = params.reviewSectionId ?? readThreadReviewSelection(paneKey)?.sectionId;
      rememberThreadWorkspaceLocation({
        name:
          params.reviewFilePath || params.reviewWorkingTreeScope
            ? "ThreadReviewFile"
            : "ThreadReview",
        params: {
          environmentId: params.environmentId,
          threadId: params.threadId,
          ...(sectionId ? { reviewSectionId: sectionId } : {}),
          ...(params.reviewFilePath ? { reviewFilePath: params.reviewFilePath } : {}),
          ...(params.reviewWorkingTreeScope
            ? { reviewWorkingTreeScope: params.reviewWorkingTreeScope }
            : {}),
        },
      });
    }
  };
  const tabs = (
    <View className="w-full border-b border-border-subtle bg-sheet px-3 py-2">
      <SegmentedControl
        size="compact"
        className="w-full"
        options={[
          { value: "git" as const, label: "Git", ...(count === undefined ? {} : { badge: count }) },
          { value: "files" as const, label: "Files" },
        ]}
        selected={selectedTab ?? "files"}
        onSelect={selectTab}
        role="tab"
      />
    </View>
  );
  const workspaceHeader = (
    <ReviewHeader
      environmentId={environmentId}
      threadId={threadId}
      title={selectedTab === "git" ? "Git" : "Files"}
      subtitle=""
      androidSubtitle=""
      selectedThreadCwd={cwd}
      selectedSection={null}
      onRefresh={async () => status.refresh()}
      onReturnToThread={() => navigation.goBack()}
    />
  );
  if (selectedTab === null)
    return (
      <View className="flex-1 bg-sheet">
        {workspaceHeader}
        {tabs}
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator accessibilityLabel="Loading workspace" />
        </View>
      </View>
    );
  return selectedTab === "files" ? (
    props.route.params.path ? (
      <ThreadFileScreen
        route={{ params: { ...props.route.params, path: props.route.params.path } }}
        workspaceTabs={tabs}
      />
    ) : (
      <ThreadFilesTreeScreen
        route={props.route}
        workspaceTabs={tabs}
        workspaceHeader={workspaceHeader}
      />
    )
  ) : (
    <ReviewSheet
      route={{ params: { environmentId, threadId } }}
      workspaceTabs={tabs}
      workspaceHeader={props.route.params.reviewSectionId ? undefined : workspaceHeader}
      openedFile={
        props.route.params.reviewSectionId &&
        (props.route.params.reviewFilePath || props.route.params.reviewWorkingTreeScope)
          ? {
              path: props.route.params.reviewFilePath,
              sectionId: props.route.params.reviewSectionId,
              scope: props.route.params.reviewWorkingTreeScope,
            }
          : undefined
      }
    />
  );
}

export function ThreadFilesWorkspaceScreen(props: Props) {
  return (
    <ThreadWorkspaceScreen
      key={`${props.route.params.environmentId}:${props.route.params.threadId}`}
      {...props}
      defaultPane="files"
    />
  );
}

export function ThreadGitWorkspaceScreen(props: Props) {
  return (
    <ThreadWorkspaceScreen
      key={`${props.route.params.environmentId}:${props.route.params.threadId}`}
      {...props}
      defaultPane="git"
    />
  );
}

export function ThreadFileWorkspaceScreen(props: Parameters<typeof ThreadFileScreen>[0]) {
  const { threadId } = props.route.params;
  if (!threadId) return <ThreadFileScreen {...props} />;
  return (
    <ThreadWorkspaceScreen
      key={`${props.route.params.environmentId}:${threadId}`}
      route={{ params: { ...props.route.params, threadId } }}
    />
  );
}
