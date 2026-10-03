import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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

import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { AudioFilePreview } from "../../components/AudioFilePreview";
import { EmptyState } from "../../components/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { LoadingScreen } from "../../components/LoadingScreen";
import { resolveFileSelectionNavigationAction } from "../../lib/adaptive-navigation";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { isPdfFile } from "../../lib/filePreview";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { MediaVideoPreviewSource } from "../../lib/videoPreviewSource";
import { useMediaActions, type MediaActionsSource } from "../../lib/mediaActions";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useEnvironmentQuery } from "../../state/query";
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
import { FileTreeBrowser } from "./FileTreeBrowser";
import { useFileTreeEntries } from "./useFileTreeEntries";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { SourceFileSurface } from "./SourceFileSurface";
import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";
import { ScreenHeader } from "../../components/ScreenHeader";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";
import { WorkspaceFilePreviewError } from "./WorkspaceFilePreviewError";
import { WorkspaceFileVideoPreview } from "./WorkspaceFileVideoPreview";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";
import {
  basename,
  fileHeaderSubtitle,
  isAudioPreviewFile,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
  isVideoPreviewFile,
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
    <ScreenHeader
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

function FileHeader(props: {
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
    <ScreenHeader
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

type FileViewMode = "preview" | "source";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
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
      isAudioPreviewFile(path))
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
  readonly onRefresh?: () => Promise<void> | void;
}) {
  // Reopening a mutable host file must not reuse a poster from an earlier visit.
  const thumbnailInstanceId = useId();
  const isMarkdown = isMarkdownPreviewFile(props.relativePath);
  const isBrowserFile = isWorkspaceBrowserPreviewPath(props.relativePath);
  const isImageFile = isWorkspaceImagePreviewPath(props.relativePath);
  const isVideoFile = isVideoPreviewFile(props.relativePath);
  const isAudioFile = isAudioPreviewFile(props.relativePath);
  // Only the surfaces that wait on a signed asset URL can be blocked by one.
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
    <View className="flex-1 bg-sheet">
      {props.truncated ? (
        <FilePreviewNotice title="Partial file">
          Preview limited to the first 1 MB of a truncated file.
        </FilePreviewNotice>
      ) : null}
      {props.activeMode === "preview" && isMarkdown ? (
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
          onRefresh={props.onRefresh}
        />
      )}
    </View>
  );
}

type ThreadFilesRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type ThreadFileRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  /** Absent for a project draft, which has no thread yet. */
  readonly threadId?: string;
  readonly path: string[];
  readonly line?: string;
  /** Supplied when there is no thread to resolve the workspace from. */
  readonly cwd?: string;
  readonly projectName?: string;
}>;

function useThreadFilesWorkspace(params: {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
  readonly cwd?: string | string[];
  readonly projectName?: string | string[];
}) {
  const routeEnvironmentId = firstRouteParam(params.environmentId);
  const routeThreadId = firstRouteParam(params.threadId);
  // A project draft has no thread to resolve a workspace from, so it names one itself.
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
    selectedThread,
    threadId,
  };
}

function FilesUnavailable() {
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <NativeStackScreenOptions options={{ title: "Files" }} />
      <EmptyState
        title="Files unavailable"
        detail="This thread does not have an active workspace path."
      />
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
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector, layout, showAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const [searchQuery, setSearchQuery] = useState("");
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace(
    props.route.params,
  );
  const revealedInspectorRef = useRef(false);
  const entriesQuery = useFileTreeEntries({
    environmentId,
    cwd: fileInspector.supported ? null : cwd,
    searchQuery,
  });
  const handleReturnToThread = useCallback(() => {
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
  }, [environmentId, navigation, threadId]);

  const handleSelectFile = useCallback(
    (path: string) => {
      if (environmentId === null || threadId === null) {
        return;
      }
      const params = {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: path.split("/").filter((segment) => segment.length > 0),
      };
      const navigationAction = resolveFileSelectionNavigationAction({
        hasPersistentFileInspector: fileInspector.supported,
      });
      if (navigationAction === "replace") {
        navigation.dispatch(StackActions.replace("ThreadFile", params));
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [environmentId, fileInspector.supported, navigation, threadId],
  );
  const renderInspector = useCallback(
    (headerInset: number) =>
      environmentId !== null && cwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={environmentId}
          headerInset={headerInset}
          projectName={projectName}
          selectedPath={null}
          onSelectFile={handleSelectFile}
        />
      ) : null,
    [cwd, environmentId, handleSelectFile, projectName],
  );
  const handlePreviewFile = useCallback(
    (relativePath: string) => {
      if (environmentId === null || cwd === null) {
        return;
      }
      preloadWorkspaceFileContents({
        cwd,
        environmentId,
        relativePath,
        theme: highlightTheme,
      });
    },
    [cwd, environmentId, highlightTheme],
  );
  useEffect(() => {
    if (fileInspector.supported && cwd !== null && !revealedInspectorRef.current) {
      revealedInspectorRef.current = true;
      showAuxiliaryPane("inspector");
    }
  }, [cwd, fileInspector.supported, showAuxiliaryPane]);

  if (selectedThread === null || environmentId === null || threadId === null) {
    if (fileInspector.supported) {
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

  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (fileInspector.supported) {
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
      <MaterialScreenContent insetHorizontal={layout.usesSplitView}>
        <FileTreeBrowser
          key={JSON.stringify([environmentId, cwd])}
          entries={entriesQuery.entries}
          loadedDirectories={entriesQuery.loadedDirectories}
          onLoadDirectory={entriesQuery.loadDirectory}
          error={entriesQuery.error}
          isPending={entriesQuery.isPending}
          searchQuery={searchQuery}
          searchTruncated={entriesQuery.searchTruncated}
          selectedPath={null}
          onPreviewFile={handlePreviewFile}
          onRefresh={entriesQuery.refresh}
          onSelectFile={handleSelectFile}
        />
        <FilesToolbarBottomFade />
      </MaterialScreenContent>
    </>
  );

  return Platform.OS === "android" ? <View className="flex-1 bg-header">{content}</View> : content;
}

export function ThreadFileScreen(props: ThreadFileRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector } = useAdaptiveWorkspaceLayout();
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const iconColor = useUniwindTheme()["--color-icon"];
  const params = props.route.params;
  const relativePath = normalizeRoutePath(params.path);
  const targetLine = normalizeRouteLine(firstRouteParam(params.line));
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace(
    props.route.params,
  );
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
      isAudioFile);
  const activeMode =
    relativePath !== null && modeOverride?.path === relativePath
      ? modeOverride.mode
      : defaultViewMode(relativePath);
  const resolvedActiveMode =
    isVideoFile || isAudioFile ? "preview" : canPreview ? activeMode : "source";
  const assetPreviewPath =
    isBrowserFile || isImageFile || isVideoFile || isAudioFile ? relativePath : null;
  const assetPreview = useWorkspaceFileAssetUrlState({
    cwd,
    environmentId,
    relativePath: assetPreviewPath,
    threadId,
    // A project draft names its workspace root explicitly: there is no thread to resolve one.
    draftCwd: threadId === null ? cwd : null,
  });
  const assetPreviewUri = assetPreview._tag === "Success" ? assetPreview.url : null;
  const mediaSource = useMemo<MediaActionsSource | undefined>(
    () =>
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
        : undefined,
    [assetPreview.resource, cwd, environmentId, isImageFile, isVideoFile, relativePath, threadId],
  );
  const mediaActions = useMediaActions(mediaSource);
  const videoSource = useMemo<MediaVideoPreviewSource | null>(
    () =>
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
        : null,
    [assetPreview.resource, environmentId, relativePath, mediaSource],
  );
  const previewUri =
    assetPreviewUri === null || previewRevision === 0
      ? assetPreviewUri
      : `${assetPreviewUri}${assetPreviewUri.includes("?") ? "&" : "?"}revision=${previewRevision}`;
  // Remounting the preview after a re-mint is what makes a failed asset URL retryable.
  const handleRetryPreview = () => {
    void assetPreview.refresh().finally(() => setPreviewRevision((current) => current + 1));
  };
  const needsFileContents =
    relativePath !== null &&
    !isVideoFile &&
    !isAudioFile &&
    (resolvedActiveMode === "source" || isMarkdownPreviewFile(relativePath));
  const fileQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && relativePath !== null && needsFileContents
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath },
        })
      : null,
  );
  const fileData = fileQuery.data as ProjectReadFileResult | null;

  const handleSelectFile = useCallback(
    (path: string) => {
      const segments = path.split("/").filter(Boolean);
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
      navigation.navigate("ThreadFile", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: segments,
      });
    },
    [cwd, environmentId, navigation, projectName, threadId],
  );
  const renderInspector = useCallback(
    (headerInset: number) =>
      fileInspector.supported && environmentId !== null && cwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={environmentId}
          headerInset={headerInset}
          projectName={projectName}
          selectedPath={relativePath}
          onSelectFile={handleSelectFile}
        />
      ) : undefined,
    [cwd, environmentId, fileInspector.supported, handleSelectFile, projectName, relativePath],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // pane brings its own nested native header; elsewhere it pads itself below
  // the top inset.
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  // Hand the file navigator to the workspace so it renders beside the
  // navigator, outside this screen's native header.
  const renderWorkspaceInspector = useCallback(
    () => renderInspector(inspectorHeaderInset),
    [inspectorHeaderInset, renderInspector],
  );
  useRegisterWorkspaceInspector(fileInspector.supported ? renderWorkspaceInspector : undefined);

  const fileMenuActions = useMemo(() => {
    if (relativePath === null) return [];
    const canToggleMode = canPreview && !isImageFile && !isVideoFile && !isAudioFile;
    return [
      canToggleMode
        ? ({
            id: "preview",
            title: "Preview",
            icon: "eye",
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
      // Only the source body wraps; a rendered preview lays itself out.
      resolvedActiveMode === "source"
        ? ({
            id: "word-wrap",
            title: appearance.codeWordBreak ? "Disable word wrap" : "Enable word wrap",
            icon: "text.alignleft",
            inline: false,
            onPress: () => setCodeWordBreak(!appearance.codeWordBreak),
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
              onPress: () => copyTextWithHaptic(relativePath),
            } as const,
          ]),
      // Selecting a long file by hand is painful on a phone, so copying the whole thing is
      // the action most readers actually want. The attachment screen already offers it.
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
      resolvedActiveMode === "preview" &&
      (isBrowserFile || isImageFile || isVideoFile || isAudioFile)
        ? ({
            id: "refresh",
            title: "Refresh",
            icon: "arrow.clockwise",
            inline: false,
            onPress: async () => {
              if (isVideoFile || isAudioFile) await assetPreview.refresh();
              setPreviewRevision((current) => current + 1);
            },
          } as const)
        : null,
    ].filter((action) => action !== null);
  }, [
    appearance.codeWordBreak,
    setCodeWordBreak,
    assetPreviewUri,
    assetPreview.refresh,
    previewUri,
    canPreview,
    isAudioFile,
    isBrowserFile,
    isImageFile,
    isVideoFile,
    relativePath,
    resolvedActiveMode,
    mediaSource,
    mediaActions.actions,
    fileData?.contents,
    fileData?.truncated,
  ]);

  const handleReturnToThread = useCallback(() => {
    if (environmentId !== null && threadId !== null) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    }
  }, [environmentId, navigation, threadId]);
  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    handleReturnToThread();
  }, [handleReturnToThread, navigation]);

  // A file opened from a project draft has no thread, and needs none: the thread only supplies
  // the workspace to read from and the target to navigate back to, both of which a draft names
  // for itself. Wait only for what this file actually cannot render without.
  if (environmentId === null || (threadId !== null && selectedThread === null)) {
    return <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />;
  }

  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (relativePath === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <NativeStackScreenOptions options={{ title: "Files" }} />
        <EmptyState title="File unavailable" detail="This file path is invalid." />
      </View>
    );
  }

  const headerSubtitle = fileHeaderSubtitle(projectName, relativePath);

  return (
    <View className="flex-1 bg-sheet">
      <FileHeader
        title={basename(relativePath)}
        subtitle={headerSubtitle}
        iconColor={iconColor}
        activeMode={resolvedActiveMode}
        fileInspectorSupported={fileInspector.supported}
        onBack={handleBack}
        onReturnToThread={handleReturnToThread}
        actions={fileMenuActions}
      />
      <MaterialScreenContent>
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
          onRefresh={() => fileQuery.refresh()}
        />
      </MaterialScreenContent>
      <FilePreviewModal
        source={fullScreenPreview}
        onRequestClose={() => setFullScreenPreview(null)}
      />
    </View>
  );
}
