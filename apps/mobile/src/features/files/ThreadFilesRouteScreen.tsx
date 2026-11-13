import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useId, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { EnvironmentId, type ProjectReadFileResult, ThreadId } from "@t3tools/contracts";
import { videoMimeType } from "@t3tools/shared/video";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  mediaMimeTypeFromExtension,
} from "@t3tools/shared/filePreview";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { DelimitedFilePreview } from "./DelimitedFilePreview";
import { AudioFilePreview } from "./AudioFilePreview";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { LoadingScreen } from "../../components/LoadingScreen";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { isPdfFile } from "../../lib/filePreview";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { MediaVideoPreviewSource } from "../../lib/videoPreviewSource";
import { useMediaActions } from "../../state/mediaActions";
import { type MediaActionsSource } from "../../lib/mediaActionsSource";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { projectEnvironment } from "../../state/projects";
import type { AssetUrlFailureReason } from "../../state/asset-url-state";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { FilePreviewLoading, FilePreviewNotice } from "./FilePreviewFeedback";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { ThreadInspectorContentStack } from "../threads/thread-inspector-content-stack";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { useFileTreeEntries } from "./useFileTreeEntries";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { SourceFileSurface } from "./SourceFileSurface";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";
import { AppBar } from "../../components/ui/AppBar";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";
import { WorkspaceFilePreviewError } from "./WorkspaceFilePreviewError";
import { WorkspaceFileVideoPreview } from "./WorkspaceFileVideoPreview";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";
import {
  basename,
  fileHeaderSubtitle,
  fileRoutePathSegments,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
  isAudioPreviewFile,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
  isVideoPreviewFile,
  needsWorkspaceFileContents,
} from "./filePath";
import { useWorkspaceFileAssetUrlState } from "./workspaceFileAssetUrl";

export function FilesBrowserHeader(props: {
  readonly projectName: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onBack: () => void;
}) {
  return (
    <AppBar
      title="Files"
      subtitle={props.projectName}
      onBack={props.onBack}
      hideBottomBorder
      matchSearchSurface
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search files",
        closeAccessibilityLabel: "Close file search",
        clearAccessibilityLabel: "Clear file search",
      }}
      menus={
        Platform.OS === "android"
          ? [
              {
                title: "File options",
                icon: "ellipsis",
                items: [{ id: "refresh", title: "Refresh files", onPress: props.onRefresh }],
              },
            ]
          : undefined
      }
    />
  );
}

export function FileHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly iconColor: string;
  readonly activeMode: string;
  readonly fileInspectorSupported: boolean;
  readonly onBack: () => void;
  readonly onReturnToThread: () => void;
  readonly actions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly inline: boolean;
    readonly onPress: () => unknown;
  }>;
}) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const modes = props.actions.filter(({ inline }) => inline);
  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBack={props.onBack}
      hideBottomBorder
      options={{ headerTintColor: props.iconColor, headerTitle: props.title }}
      backInSplitView={
        props.fileInspectorSupported
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={
        props.fileInspectorSupported
          ? [
              {
                accessibilityLabel: panes.auxiliaryPaneVisible
                  ? "Hide file navigator"
                  : "Show file navigator",
                icon: "sidebar.right",
                selected: panes.auxiliaryPaneVisible,
                onPress: toggleAuxiliaryPane,
              },
            ]
          : undefined
      }
      menus={[
        {
          title: "File actions",
          icon: "ellipsis",
          separateBackground: false,
          items: [
            ...(modes.length > 0
              ? [
                  {
                    id: "modes",
                    inline: true,
                    items: modes.map((action) => ({
                      ...action,
                      selected: action.id === props.activeMode,
                    })),
                  },
                ]
              : []),
            ...props.actions.filter(({ inline }) => !inline),
          ],
        },
      ]}
    />
  );
}

export type FileViewMode = "preview" | "source";

export function firstRouteParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim().length === 0 ? null : first;
}

function normalizeRoutePath(value: string | string[] | undefined): string | null {
  const path = Array.isArray(value) ? value.join("/") : value;
  if (path === undefined || path.trim().length === 0) {
    return null;
  }
  return path;
}

export function normalizeRouteLine(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function defaultViewMode(path: string | null): FileViewMode {
  return path !== null &&
    (isWorkspaceBrowserPreviewPath(path) ||
      isWorkspaceImagePreviewPath(path) ||
      isVideoPreviewFile(path) ||
      isAudioPreviewFile(path) ||
      filePreviewDelimiter({ name: path }) !== null)
    ? "preview"
    : "source";
}

export function FileContent(props: {
  readonly activeMode: FileViewMode;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly previewUri: string | null;
  readonly previewFailure: AssetUrlFailureReason | null;
  readonly onRetryPreview: () => void;
  readonly videoSource: MediaVideoPreviewSource | null;
  readonly mediaSource?: MediaActionsSource;
  readonly resolveVideoUri: () => Promise<string | null>;
  readonly fileContents: string | null;
  readonly fileError: string | null;
  readonly relativePath: string;
  readonly threadId: ThreadId | null;
  readonly initialLine: number | null;
  readonly truncated: boolean;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  // Reopening a mutable host file must not reuse a poster from an earlier visit.
  const thumbnailInstanceId = useId();
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const reservedHeaderInset =
    Platform.OS === "ios" && props.truncated ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
  const isMarkdown = isMarkdownPreviewFile(props.relativePath);
  const delimiter = filePreviewDelimiter({ name: props.relativePath });
  const isBrowserFile = isWorkspaceBrowserPreviewPath(props.relativePath);
  const isImageFile = isWorkspaceImagePreviewPath(props.relativePath);
  const isVideoFile = isVideoPreviewFile(props.relativePath);
  const isAudioFile = isAudioPreviewFile(props.relativePath);
  const needsAssetUrl =
    isVideoFile ||
    isAudioFile ||
    (props.activeMode === "preview" && (isImageFile || isBrowserFile));

  if (needsAssetUrl && props.previewFailure !== null) {
    return (
      <WorkspaceFilePreviewError
        environmentId={props.environmentId}
        reason={props.previewFailure}
        onRetry={props.onRetryPreview}
      />
    );
  }

  if (isVideoFile) {
    return (
      <WorkspaceFileVideoPreview
        name={basename(props.relativePath)}
        thumbnailKey={`workspace-video:${thumbnailInstanceId}`}
        uri={props.previewUri}
        source={props.videoSource}
        resolvePlaybackUri={props.resolveVideoUri}
      />
    );
  }

  if (isAudioFile) {
    return props.previewUri === null ? (
      <FilePreviewLoading message="Loading file..." />
    ) : (
      <AudioFilePreview uri={props.previewUri} onRetry={props.onRetryPreview} />
    );
  }

  if (props.activeMode === "preview" && isImageFile) {
    if (isSvgImagePreviewFile(props.relativePath)) {
      return <WorkspaceFileWebPreview uri={props.previewUri} />;
    }
    return (
      <WorkspaceFileImagePreview
        accessibilityLabel={basename(props.relativePath)}
        uri={props.previewUri}
        actionsSource={props.mediaSource}
      />
    );
  }

  if (props.activeMode === "preview" && isBrowserFile) {
    return <WorkspaceFileWebPreview uri={props.previewUri} />;
  }

  if (props.fileError && props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState title="File unavailable" detail={props.fileError} />
      </View>
    );
  }

  if (props.fileContents === null) {
    return <FilePreviewLoading message="Loading file..." />;
  }

  return (
    <View className="flex-1 bg-sheet" style={{ paddingTop: reservedHeaderInset }}>
      {props.truncated ? (
        <FilePreviewNotice title="Partial file">
          Preview limited to the first 1 MB of a truncated file.
        </FilePreviewNotice>
      ) : null}
      {props.activeMode === "preview" && delimiter ? (
        <DelimitedFilePreview table={parseDelimitedPreview(props.fileContents, delimiter)} />
      ) : props.activeMode === "preview" && isMarkdown ? (
        <FileMarkdownPreview
          cwd={props.cwd}
          environmentId={props.environmentId}
          markdown={props.fileContents}
          relativePath={props.relativePath}
          threadId={props.threadId}
          onRefresh={props.onRefresh}
        />
      ) : (
        <SourceFileSurface
          contents={props.fileContents}
          path={props.relativePath}
          initialLine={props.initialLine}
          headerInsetTop={props.truncated ? 0 : undefined}
          onRefresh={props.onRefresh}
        />
      )}
    </View>
  );
}

type ThreadFilesRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId?: string;
  readonly cwd?: string;
  readonly projectName?: string;
}>;

export type ThreadFileRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId?: string;
  readonly path: string[];
  readonly line?: string;
  readonly cwd?: string;
  readonly projectName?: string;
}>;

export function useThreadFilesWorkspace(params: {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
  readonly cwd?: string | string[];
  readonly projectName?: string | string[];
  readonly path?: string | string[];
}) {
  const routeEnvironmentId = firstRouteParam(params.environmentId);
  const routeThreadId = firstRouteParam(params.threadId);
  const routeCwd = firstRouteParam(params.cwd);
  const routeProjectName = firstRouteParam(params.projectName);
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const environmentId =
    routeEnvironmentId !== null
      ? EnvironmentId.make(routeEnvironmentId)
      : (selectedThread?.environmentId ?? null);
  const threadId = routeThreadId !== null ? ThreadId.make(routeThreadId) : null;
  const project = selectedThreadProject as {
    readonly title?: string;
    readonly workspaceRoot?: string;
  } | null;

  return {
    cwd: routeCwd ?? selectedThreadCwd ?? project?.workspaceRoot ?? null,
    environmentId,
    projectName: routeProjectName ?? project?.title ?? "Files",
    relativePath: normalizeRoutePath(params.path),
    selectedThread,
    threadId,
  };
}

export function FilesUnavailable({
  detail = "This thread does not have an active workspace path.",
}: {
  detail?: string;
}) {
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <NativeStackScreenOptions options={{ title: "Files" }} />
      <EmptyState title="Files unavailable" detail={detail} />
    </View>
  );
}

export function FilesToolbarBottomFade() {
  const sheetColor = String(useUniwindTheme()["--color-sheet"]);

  if (process.env.EXPO_OS !== "ios") {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 bottom-0 z-[1] h-28"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="files-toolbar-bottom-fade" x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0%" stopColor={sheetColor} stopOpacity={0} />
            <Stop offset="58%" stopColor={sheetColor} stopOpacity={0.72} />
            <Stop offset="100%" stopColor={sheetColor} stopOpacity={0.96} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#files-toolbar-bottom-fade)" />
      </Svg>
    </View>
  );
}

export function ThreadFilesTreeScreen(props: ThreadFilesRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector, layout } = useAdaptiveWorkspaceLayout();
  const [searchQuery, setSearchQuery] = useState("");
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace(
    props.route.params,
  );
  const hasFileInspector = fileInspector.supported && threadId !== null;
  const fileAccessSession = useEnvironmentQuery(
    environmentId !== null ? environmentSession.sessionStateAtom(environmentId) : null,
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const entriesQuery = useFileTreeEntries({
    environmentId,
    cwd: canReadFiles && !hasFileInspector ? cwd : null,
    searchQuery,
  });
  const handleReturnToThread = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (environmentId !== null && threadId !== null) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    }
  };

  const handleSelectFile = (path: string) => {
    if (environmentId === null || cwd === null) {
      return;
    }
    const params = {
      environmentId: String(environmentId),
      ...(threadId === null ? { cwd, projectName } : { threadId: String(threadId) }),
      path: path.split("/").filter((segment) => segment.length > 0),
    };
    if (threadId === null) {
      navigation.navigate("NewTaskFile", params);
      return;
    }
    if (hasFileInspector) {
      navigation.dispatch(StackActions.replace("ThreadFile", params));
      return;
    }
    navigation.navigate("ThreadFile", params);
  };
  const renderInspector = (headerInset: number) =>
    environmentId !== null && cwd !== null ? (
      <ThreadFileNavigatorPane
        cwd={cwd}
        environmentId={environmentId}
        headerInset={headerInset}
        projectName={projectName}
        selectedPath={null}
        onSelectFile={handleSelectFile}
      />
    ) : null;
  const handlePreviewFile = (relativePath: string) => {
    if (environmentId === null || cwd === null) {
      return;
    }
    preloadWorkspaceFileContents({
      cwd,
      environmentId,
      relativePath,
      theme: highlightTheme,
    });
  };
  if (environmentId === null || (threadId !== null && selectedThread === null)) {
    if (hasFileInspector) {
      return (
        <ThreadRouteScreen
          onReturnToThread={handleReturnToThread}
          renderInspector={renderInspector}
          route={props.route}
        />
      );
    }
    return <LoadingScreen message="Opening files..." messagePlacement="above-spinner" />;
  }

  if (!canReadFiles) {
    if (fileAccess.isPending) {
      return <LoadingScreen message="Checking file access..." messagePlacement="above-spinner" />;
    }
    return (
      <FilesUnavailable detail={fileAccess.error ?? "This connection cannot read host files."} />
    );
  }
  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (hasFileInspector) {
    return (
      <ThreadRouteScreen
        onReturnToThread={handleReturnToThread}
        renderInspector={renderInspector}
        route={props.route}
      />
    );
  }

  const content = (
    <>
      <FilesBrowserHeader
        projectName={projectName}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onRefresh={entriesQuery.refresh}
        onBack={handleReturnToThread}
      />
      <ScreenContent insetHorizontal={layout.usesSplitView}>
        <FileTreeBrowser
          key={JSON.stringify([environmentId, cwd])}
          revealSelection={entriesQuery.revealSelection}
          expandedPaths={entriesQuery.expandedPaths}
          setExpandedPaths={entriesQuery.setExpandedPaths}
          entries={entriesQuery.entries}
          loadingDirectories={entriesQuery.loadingDirectories}
          onLoadDirectory={entriesQuery.loadDirectory}
          error={entriesQuery.error}
          isPending={entriesQuery.isPending}
          isRefreshing={entriesQuery.isRefreshing}
          searchQuery={searchQuery}
          searchResultPaths={entriesQuery.searchResultPaths}
          searchTruncated={entriesQuery.searchTruncated}
          selectedPath={entriesQuery.selectedPath}
          onPreviewFile={handlePreviewFile}
          onRefresh={entriesQuery.refresh}
          onSelectFile={(path) => {
            entriesQuery.selectPath(path);
            handleSelectFile(path);
          }}
        />
        <FilesToolbarBottomFade />
      </ScreenContent>
    </>
  );

  return Platform.OS === "android" ? <View className="flex-1 bg-header">{content}</View> : content;
}
export * from "./ThreadFilesRouteScreenParts";
