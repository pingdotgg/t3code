import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { type ReactNode, useId, useState } from "react";
import { Platform, View } from "react-native";
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
import { Inspector, useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { FilePreviewLoading, FilePreviewNotice } from "./FilePreviewFeedback";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { useFileTreeEntries } from "./useFileTreeEntries";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { SourceFileSurface } from "./SourceFileSurface";
import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";
import { AppBar } from "../../components/ui/AppBar";
import { useContentTopInset } from "../../components/ui/useBarInset";
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

function FilesBrowserHeader(props: {
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
      refresh={{ accessibilityLabel: "Refresh files", onPress: props.onRefresh }}
    />
  );
}

function FileHeader(props: {
  readonly title: string;
  readonly subtitle: string;
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

type FileViewMode = "preview" | "source";

function firstRouteParam(value: string | string[] | undefined): string | null {
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

function normalizeRouteLine(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function defaultViewMode(path: string | null): FileViewMode {
  return path !== null &&
    (isWorkspaceBrowserPreviewPath(path) ||
      isWorkspaceImagePreviewPath(path) ||
      isVideoPreviewFile(path) ||
      isAudioPreviewFile(path) ||
      filePreviewDelimiter({ name: path }) !== null)
    ? "preview"
    : "source";
}

function FileContent(props: {
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
  readonly selectable: boolean;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  // Reopening a mutable host file must not reuse a poster from an earlier visit.
  const thumbnailInstanceId = useId();
  const barOverlap = useContentTopInset();
  const reservedHeaderInset = props.truncated ? barOverlap : 0;
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
          selectable={props.selectable}
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

type ThreadFileRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId?: string;
  readonly path: string[];
  readonly line?: string;
  readonly cwd?: string;
  readonly projectName?: string;
}>;

function useThreadFilesWorkspace(params: {
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

function FilesUnavailable({
  title = "Files unavailable",
  detail = "This thread does not have an active workspace path.",
  onBack,
}: {
  title?: string;
  detail?: string;
  onBack: () => void;
}) {
  return (
    <View className="flex-1 bg-sheet">
      <AppBar title="Files" onBack={onBack} onBackToList={onBack} hideBottomBorder />
      <ScreenContent>
        <View className="flex-1 items-center justify-center px-6">
          <EmptyState title={title} detail={detail} />
        </View>
      </ScreenContent>
    </View>
  );
}

function FilesToolbarBottomFade() {
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
  const navigation = useNavigation();
  const { fileInspector } = useAdaptiveWorkspaceLayout();
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
  const renderInspector = () =>
    environmentId !== null && cwd !== null ? (
      <ThreadFileNavigatorPane
        cwd={cwd}
        environmentId={environmentId}
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
      <FilesUnavailable
        detail={fileAccess.error ?? "This connection cannot read host files."}
        onBack={handleReturnToThread}
      />
    );
  }
  if (cwd === null) {
    return <FilesUnavailable onBack={handleReturnToThread} />;
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

  return (
    <View className="flex-1">
      <FilesBrowserHeader
        projectName={projectName}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onRefresh={entriesQuery.refresh}
        onBack={handleReturnToThread}
      />
      <ScreenContent>
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
    </View>
  );
}

export function ThreadFileScreen(props: ThreadFileRouteScreenProps) {
  const navigation = useNavigation();
  const { fileInspector } = useAdaptiveWorkspaceLayout();
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const params = props.route.params;
  const targetLine = normalizeRouteLine(firstRouteParam(params.line));
  const { cwd, environmentId, projectName, relativePath, selectedThread, threadId } =
    useThreadFilesWorkspace(props.route.params);
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
  const targetPath =
    cwd !== null && relativePath !== null ? resolveWorkspaceFilePath(cwd, relativePath) : null;
  const metadata = useEnvironmentQuery(
    canReadFiles && environmentId !== null && targetPath !== null
      ? projectEnvironment.fileMetadata({ environmentId, input: { path: targetPath } })
      : null,
  );
  const metadataPending = !metadata.isSuccess && metadata.error === null;
  const directoryPath = metadata.data?.kind === "directory" ? targetPath : null;
  const [searchQuery, setSearchQuery] = useState("");
  const entriesQuery = useFileTreeEntries({
    environmentId,
    cwd: canReadFiles ? directoryPath : null,
    searchQuery,
  });
  const [modeOverride, setModeOverride] = useState<{
    readonly path: string;
    readonly mode: FileViewMode;
  } | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const previewKey = JSON.stringify([environmentId, cwd, relativePath, previewRevision]);
  const [fullScreenPreview, setFullScreenPreview] = useState<FilePreviewSource | null>(null);
  const isVideoFile = relativePath !== null && isVideoPreviewFile(relativePath);
  const isAudioFile = relativePath !== null && !isVideoFile && isAudioPreviewFile(relativePath);
  const isBrowserFile =
    relativePath !== null && !isVideoFile && isWorkspaceBrowserPreviewPath(relativePath);
  const isImageFile =
    relativePath !== null && !isVideoFile && isWorkspaceImagePreviewPath(relativePath);
  const canPreview =
    relativePath !== null &&
    (isMarkdownPreviewFile(relativePath) ||
      isBrowserFile ||
      isImageFile ||
      isVideoFile ||
      isAudioFile ||
      filePreviewDelimiter({ name: relativePath }) !== null);
  const activeMode =
    relativePath !== null && modeOverride?.path === relativePath
      ? modeOverride.mode
      : targetLine !== null && filePreviewDelimiter({ name: relativePath ?? "" }) !== null
        ? "source"
        : defaultViewMode(relativePath);
  const resolvedActiveMode =
    isVideoFile || isAudioFile ? "preview" : canPreview ? activeMode : "source";
  const assetPreviewPath =
    !metadataPending &&
    directoryPath === null &&
    (isBrowserFile || isImageFile || isVideoFile || isAudioFile)
      ? relativePath
      : null;
  const assetPreview = useWorkspaceFileAssetUrlState({
    cwd,
    environmentId,
    relativePath: assetPreviewPath,
    threadId,
    draftCwd: threadId === null ? cwd : null,
  });
  const assetPreviewUri = assetPreview._tag === "Success" ? assetPreview.url : null;
  const mediaSource: MediaActionsSource | undefined =
    environmentId !== null &&
    relativePath !== null &&
    assetPreview.resource !== null &&
    "path" in assetPreview.resource &&
    typeof assetPreview.resource.path === "string" &&
    (isImageFile || isVideoFile)
      ? {
          reference: mediaFileReference(assetPreview.resource.path, cwd),
          name: basename(relativePath),
          mimeType:
            mediaMimeTypeFromExtension(relativePath.slice(relativePath.lastIndexOf("."))) ??
            "application/octet-stream",
          environmentId,
          ...(threadId === null ? {} : { threadId }),
          resource: assetPreview.resource,
        }
      : undefined;
  const mediaActions = useMediaActions(mediaSource);
  const videoSource: MediaVideoPreviewSource | null =
    environmentId !== null &&
    relativePath !== null &&
    (assetPreview.resource?._tag === "media-file" ||
      assetPreview.resource?._tag === "draft-workspace-file")
      ? {
          type: "media",
          environmentId,
          resource: assetPreview.resource,
          name: basename(relativePath),
          mimeType: videoMimeType({ name: relativePath, mimeType: "" }) ?? "video/mp4",
          actionsSource: mediaSource,
        }
      : null;
  const previewUri =
    assetPreviewUri === null || previewRevision === 0
      ? assetPreviewUri
      : `${assetPreviewUri}${assetPreviewUri.includes("?") ? "&" : "?"}revision=${previewRevision}`;
  // Remounting the preview after a re-mint is what makes a failed asset URL retryable.
  const handleRetryPreview = () => {
    void assetPreview.refresh().finally(() => setPreviewRevision((current) => current + 1));
  };
  // Metadata is needed only to distinguish directories; file contents can load concurrently.
  const needsFileContents = needsWorkspaceFileContents({
    relativePath,
    metadataKind: metadata.data?.kind,
    activeMode: resolvedActiveMode,
  });
  const fileQuery = useEnvironmentQuery(
    canReadFiles &&
      environmentId !== null &&
      cwd !== null &&
      relativePath !== null &&
      needsFileContents
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath },
        })
      : null,
  );
  const fileData = fileQuery.data as ProjectReadFileResult | null;
  // Android numbered rows are separate text views, so selection spanning lines needs the
  // continuous renderer. It stays opt-in because it lays out the whole file at once.
  const selectionScope = JSON.stringify([environmentId, cwd, relativePath]);
  const [textSelectionScope, setTextSelectionScope] = useState<string | null>(null);
  const canSelectText =
    Platform.OS === "android" && resolvedActiveMode === "source" && fileData?.contents != null;
  const selectingText = canSelectText && textSelectionScope === selectionScope;

  const handleSelectFile = (path: string) => {
    const targetPath =
      directoryPath === null ? path : resolveWorkspaceFilePath(directoryPath, path);
    const segments = fileRoutePathSegments(
      resolveWorkspaceRelativeFilePath(cwd, targetPath) ?? targetPath,
    );
    // A draft has no thread. `ThreadFile` would stringify null and then wait forever for a
    // thread to resolve, so a draft stays on its own route and carries its workspace along.
    if (threadId === null) {
      navigation.dispatch(
        StackActions.push("NewTaskFile", {
          environmentId: String(environmentId),
          ...(cwd === null ? {} : { cwd }),
          projectName,
          path: segments,
        }),
      );
      return;
    }
    const destination = {
      environmentId: String(environmentId),
      threadId: String(threadId),
      path: segments,
    };
    if (directoryPath !== null) navigation.dispatch(StackActions.push("ThreadFile", destination));
    else navigation.navigate("ThreadFile", destination);
  };
  const renderInspector = () =>
    fileInspector.supported && environmentId !== null && cwd !== null ? (
      <ThreadFileNavigatorPane
        cwd={directoryPath ?? cwd}
        environmentId={environmentId}
        projectName={directoryPath ?? projectName}
        selectedPath={directoryPath === null ? relativePath : null}
        onSelectFile={(path) => {
          if (directoryPath !== null) entriesQuery.selectPath(path);
          handleSelectFile(path);
        }}
      />
    ) : undefined;
  const inspector = fileInspector.supported ? (
    <Inspector
      content={{
        active: "files",
        resetKeys: [threadId, cwd],
        panes: [{ key: "files", render: renderInspector }],
      }}
    />
  ) : null;
  const withInspector = (content: ReactNode) => (
    <>
      {inspector}
      {content}
    </>
  );

  const fileMenuActions = (() => {
    if (relativePath === null) return [];
    const canToggleMode = canPreview && !isImageFile && !isVideoFile && !isAudioFile;
    return [
      canToggleMode
        ? ({
            id: "preview",
            title: filePreviewDelimiter({ name: relativePath }) ? "Table" : "Preview",
            icon: filePreviewDelimiter({ name: relativePath }) ? "tablecells" : "eye",
            inline: true,
            onPress: () => setModeOverride({ path: relativePath, mode: "preview" }),
          } as const)
        : null,
      canToggleMode
        ? ({
            id: "source",
            title: "Source",
            icon: "doc.text",
            inline: true,
            onPress: () => setModeOverride({ path: relativePath, mode: "source" }),
          } as const)
        : null,
      resolvedActiveMode === "source"
        ? ({
            id: "word-wrap",
            title: appearance.codeWordBreak ? "Disable word wrap" : "Enable word wrap",
            icon: "text.alignleft",
            inline: false,
            onPress: () => setCodeWordBreak(!appearance.codeWordBreak),
          } as const)
        : null,
      canSelectText
        ? ({
            id: "select-text",
            title: selectingText ? "Done selecting text" : "Select text",
            icon: selectingText ? "checkmark" : "doc.text",
            inline: false,
            onPress: () => setTextSelectionScope(selectingText ? null : selectionScope),
          } as const)
        : null,
      ...(mediaSource
        ? mediaActions.actions
            .filter(({ id }) => id !== "open-file")
            .map((action) => ({
              id: action.id,
              title: action.title,
              icon:
                action.id === "save" ? ("square.and.arrow.up" as const) : ("doc.on.doc" as const),
              inline: false,
              onPress: action.run,
            }))
        : [
            {
              id: "copy-path",
              title: "Copy path",
              icon: "doc.on.doc",
              inline: false,
              onPress: () =>
                copyTextWithHaptic(
                  formatFilePathForClipboard(
                    relativePath,
                    resolvePathLinkTarget(relativePath, cwd ?? ""),
                  ),
                ),
            } as const,
          ]),
      fileData?.contents != null
        ? ({
            id: "copy-contents",
            title: fileData.truncated ? "Copy preview" : "Copy contents",
            icon: "doc.on.doc",
            inline: false,
            onPress: () => copyTextWithHaptic(fileData.contents),
          } as const)
        : null,
      isPdfFile({ name: relativePath }) && previewUri !== null
        ? ({
            id: "open-pdf",
            title: "Open PDF",
            icon: "arrow.up.left.and.arrow.down.right",
            inline: false,
            onPress: () =>
              setFullScreenPreview({
                kind: "pdf",
                uri: previewUri,
                name: basename(relativePath),
              }),
          } as const)
        : null,
      isBrowserFile && typeof assetPreviewUri === "string"
        ? ({
            id: "open-browser",
            title: Platform.OS === "ios" ? "Open in Safari" : "Open in browser",
            icon: "safari",
            inline: false,
            onPress: () => tryOpenExternalUrl(assetPreviewUri, "file-preview"),
          } as const)
        : null,
      selectingText ||
      (resolvedActiveMode === "preview" &&
        (isBrowserFile || isImageFile || isVideoFile || isAudioFile))
        ? ({
            id: "refresh",
            title: "Refresh",
            icon: "arrow.clockwise",
            inline: false,
            onPress: async () => {
              if (selectingText) {
                await fileQuery.refresh();
                return;
              }
              if (isVideoFile || isAudioFile) await assetPreview.refresh();
              setPreviewRevision((current) => current + 1);
            },
          } as const)
        : null,
    ].filter((action) => action !== null);
  })();

  const handleReturnToThread = () => {
    if (environmentId !== null && threadId !== null) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    }
  };
  const handleBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    handleReturnToThread();
  };

  if (environmentId === null || (threadId !== null && selectedThread === null)) {
    return withInspector(
      <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />,
    );
  }

  if (!canReadFiles) {
    if (fileAccess.isPending) {
      return withInspector(
        <LoadingScreen message="Checking file access..." messagePlacement="above-spinner" />,
      );
    }
    return withInspector(
      <FilesUnavailable
        detail={fileAccess.error ?? "This connection cannot read host files."}
        onBack={handleBack}
      />,
    );
  }
  if (cwd === null) {
    return withInspector(<FilesUnavailable onBack={handleBack} />);
  }

  if (relativePath === null) {
    return withInspector(
      <FilesUnavailable
        title="File unavailable"
        detail="This file path is invalid."
        onBack={handleBack}
      />,
    );
  }

  if (metadataPending) {
    return withInspector(
      <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />,
    );
  }
  if (directoryPath !== null) {
    return withInspector(
      <View className="flex-1 bg-sheet">
        <FilesBrowserHeader
          projectName={directoryPath}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onRefresh={entriesQuery.refresh}
          onBack={handleBack}
        />
        <ScreenContent>
          <FileTreeBrowser
            key={JSON.stringify([environmentId, directoryPath])}
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
            onRefresh={entriesQuery.refresh}
            onSelectFile={(path) => {
              entriesQuery.selectPath(path);
              handleSelectFile(path);
            }}
          />
          <FilesToolbarBottomFade />
        </ScreenContent>
      </View>,
    );
  }

  const headerSubtitle = fileHeaderSubtitle(projectName, relativePath);

  return withInspector(
    <View className="flex-1 bg-sheet">
      <FileHeader
        title={basename(relativePath)}
        subtitle={headerSubtitle}
        activeMode={resolvedActiveMode}
        fileInspectorSupported={fileInspector.supported}
        onBack={handleBack}
        onReturnToThread={handleReturnToThread}
        actions={fileMenuActions}
      />
      <ScreenContent>
        <FileContent
          key={previewKey}
          activeMode={resolvedActiveMode}
          cwd={cwd}
          environmentId={environmentId}
          previewUri={previewUri}
          previewFailure={assetPreview._tag === "Failure" ? assetPreview.reason : null}
          onRetryPreview={handleRetryPreview}
          videoSource={videoSource}
          mediaSource={mediaSource}
          resolveVideoUri={assetPreview.refresh}
          fileContents={fileData?.contents ?? null}
          fileError={fileQuery.error}
          initialLine={targetLine}
          relativePath={relativePath}
          threadId={threadId}
          truncated={fileData?.truncated ?? false}
          selectable={selectingText}
          onRefresh={() => fileQuery.refresh()}
        />
      </ScreenContent>
      <FilePreviewModal
        source={fullScreenPreview}
        onRequestClose={() => setFullScreenPreview(null)}
      />
    </View>,
  );
}
