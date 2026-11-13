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
import type { FileViewMode, ThreadFileRouteScreenProps } from "./ThreadFilesRouteScreen";
import { FileContent, FileHeader, FilesBrowserHeader, FilesToolbarBottomFade, FilesUnavailable, defaultViewMode, firstRouteParam, normalizeRouteLine, useThreadFilesWorkspace } from "./ThreadFilesRouteScreen";

export function ThreadFileScreen(props: ThreadFileRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector } = useAdaptiveWorkspaceLayout();
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const iconColor = useUniwindTheme()["--color-icon"];
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
  const renderInspector = (headerInset: number) =>
    fileInspector.supported && environmentId !== null && cwd !== null ? (
      <ThreadFileNavigatorPane
        cwd={directoryPath ?? cwd}
        environmentId={environmentId}
        headerInset={headerInset}
        projectName={directoryPath ?? projectName}
        selectedPath={directoryPath === null ? relativePath : null}
        onSelectFile={(path) => {
          if (directoryPath !== null) entriesQuery.selectPath(path);
          handleSelectFile(path);
        }}
      />
    ) : undefined;
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const renderWorkspaceInspector = () => (
    <ThreadInspectorContentStack
      mode="files"
      resetKeys={[threadId, cwd]}
      renderFiles={() => renderInspector(inspectorHeaderInset)}
    />
  );
  useRegisterWorkspaceInspector(fileInspector.supported ? renderWorkspaceInspector : undefined);

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
    return <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />;
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

  if (relativePath === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <NativeStackScreenOptions options={{ title: "Files" }} />
        <EmptyState title="File unavailable" detail="This file path is invalid." />
      </View>
    );
  }

  if (metadataPending) {
    return <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />;
  }
  if (directoryPath !== null) {
    return (
      <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-sheet"}>
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
          onRefresh={() => fileQuery.refresh()}
        />
      </ScreenContent>
      <FilePreviewModal
        source={fullScreenPreview}
        onRequestClose={() => setFullScreenPreview(null)}
      />
    </View>
  );
}

