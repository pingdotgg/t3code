import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  EnvironmentId,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
  ThreadId,
} from "@t3tools/contracts";
import { videoMimeType } from "@t3tools/shared/video";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
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
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { ReviewHighlighterProvider } from "../review/ReviewHighlighterProvider";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { SourceFileSurface } from "./SourceFileSurface";
import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";
import { WorkspaceFileVideoPreview } from "./WorkspaceFileVideoPreview";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";
import {
  basename,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
  isVideoPreviewFile,
} from "./filePath";
import { useWorkspaceFileAssetUrlState } from "./workspaceFileAssetUrl";

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
    (isBrowserPreviewFile(path) || isImagePreviewFile(path) || isVideoPreviewFile(path))
    ? "preview"
    : "source";
}

function FileContent(props: {
  readonly activeMode: FileViewMode;
  readonly previewUri: string | null;
  readonly previewUnavailable: boolean;
  readonly videoSource: MediaVideoPreviewSource | null;
  readonly mediaSource?: MediaActionsSource;
  readonly resolveVideoUri: () => Promise<string | null>;
  readonly fileContents: string | null;
  readonly fileError: string | null;
  readonly relativePath: string;
  readonly initialLine: number | null;
  readonly truncated: boolean;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  // Reopening a mutable host file must not reuse a poster from an earlier visit.
  const thumbnailInstanceId = useId();
  const isMarkdown = isMarkdownPreviewFile(props.relativePath);
  const isBrowserFile = isBrowserPreviewFile(props.relativePath);
  const isImageFile = isImagePreviewFile(props.relativePath);

  if (isVideoPreviewFile(props.relativePath)) {
    return (
      <WorkspaceFileVideoPreview
        name={basename(props.relativePath)}
        thumbnailKey={`workspace-video:${thumbnailInstanceId}`}
        uri={props.previewUri}
        source={props.videoSource}
        resolvePlaybackUri={props.resolveVideoUri}
        unavailable={props.previewUnavailable}
      />
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
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Loading file...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      {props.truncated ? (
        <View className="border-b border-adaptive-amber-200-900-a60 bg-adaptive-amber-50-950-a40 px-4 py-2">
          <Text className="text-2xs font-t3-bold uppercase text-adaptive-amber-700-300">
            Partial file
          </Text>
          <Text className="text-xs leading-snug text-adaptive-amber-800-200">
            Preview limited to the first 1 MB of a truncated file.
          </Text>
        </View>
      ) : null}
      {props.activeMode === "preview" && isMarkdown ? (
        <FileMarkdownPreview markdown={props.fileContents} onRefresh={props.onRefresh} />
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
  readonly threadId: string;
  readonly path: string[];
  readonly line?: string;
}>;

function useThreadFilesWorkspace(params: {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
}) {
  const routeEnvironmentId = firstRouteParam(params.environmentId);
  const routeThreadId = firstRouteParam(params.threadId);
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
    cwd: selectedThreadCwd ?? project?.workspaceRoot ?? null,
    environmentId,
    projectName: project?.title ?? "Files",
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
  const { fileInspector, layout, panes, showAuxiliaryPane, togglePrimarySidebar } =
    useAdaptiveWorkspaceLayout();
  const [searchQuery, setSearchQuery] = useState("");
  const isAndroid = Platform.OS === "android";
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const theme = useUniwindTheme();
  const sheetSurfaceColor = theme["--color-sheet-solid"];
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace(
    props.route.params,
  );
  const revealedInspectorRef = useRef(false);
  const entriesQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && !fileInspector.supported
      ? projectEnvironment.listEntries({
          environmentId,
          input: { cwd },
        })
      : null,
  );
  const entriesData = entriesQuery.data as ProjectListEntriesResult | null;
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

  const usesCompactMailToolbar =
    Platform.OS === "ios" && !layout.usesSplitView && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;

  return (
    <>
      {/* Static header config (glass preset and title) lives in Stack.tsx. The
          live sheet color stays dynamic here so the FlatList can remain the
          direct scene child for native scroll-edge sampling. */}
      <NativeStackScreenOptions
        options={{
          contentStyle: { backgroundColor: sheetSurfaceColor },
          headerShown: !isAndroid,
          unstable_headerSubtitle:
            Platform.OS === "ios" && projectName.length > 0 ? projectName : undefined,
          // No refresh button: the list already supports pull-to-refresh.
          unstable_headerToolbarItems: usesCompactMailToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: setSearchQuery,
                  placeholder: "Search files",
                  searchTextChangeId: "files-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesCompactMailToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                placeholder: "Search files",
                onChangeText: (event) => {
                  setSearchQuery(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  setSearchQuery("");
                },
              },
        }}
      />
      {isAndroid ? (
        <>
          <AndroidScreenHeader
            title="Files"
            subtitle={projectName}
            onBack={handleReturnToThread}
            actions={[
              {
                accessibilityLabel: "Refresh files",
                icon: "arrow.clockwise",
                onPress: entriesQuery.refresh,
              },
            ]}
          />
          <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
            <SymbolView
              name="magnifyingglass"
              size={17}
              tintColorClassName={"accent-icon-muted"}
              type="monochrome"
            />
            <TextInput
              accessibilityLabel="Search files"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-10 flex-1 rounded-xl py-2 text-sm"
              placeholder="Search files"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
        </>
      ) : (
        <>
          {layout.usesSplitView ? (
            <NativeHeaderToolbar placement="left">
              <NativeHeaderToolbar.Button
                accessibilityLabel={panes.primarySidebarVisible ? "Maximize files" : "Show threads"}
                icon={
                  panes.primarySidebarVisible
                    ? "arrow.up.left.and.arrow.down.right"
                    : "sidebar.left"
                }
                onPress={togglePrimarySidebar}
                separateBackground
              />
            </NativeHeaderToolbar>
          ) : null}
          {usesCompactMailToolbar ? null : (
            <NativeHeaderToolbar placement="bottom">
              <NativeHeaderToolbar.SearchBarSlot />
            </NativeHeaderToolbar>
          )}
        </>
      )}
      <FileTreeBrowser
        entries={entriesData?.entries ?? []}
        error={entriesQuery.error}
        isPending={entriesQuery.isPending}
        searchQuery={searchQuery}
        selectedPath={null}
        onPreviewFile={handlePreviewFile}
        onRefresh={entriesQuery.refresh}
        onSelectFile={handleSelectFile}
      />
      <FilesToolbarBottomFade />
    </>
  );
}

export function ThreadFileScreen(props: ThreadFileRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const iconColor = useUniwindTheme()["--color-icon"];
  const isAndroid = Platform.OS === "android";
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
  const isBrowserFile = relativePath !== null && !isVideoFile && isBrowserPreviewFile(relativePath);
  const isImageFile = relativePath !== null && !isVideoFile && isImagePreviewFile(relativePath);
  const canPreview =
    relativePath !== null &&
    (isMarkdownPreviewFile(relativePath) || isBrowserFile || isImageFile || isVideoFile);
  const activeMode =
    relativePath !== null && modeOverride?.path === relativePath
      ? modeOverride.mode
      : defaultViewMode(relativePath);
  const resolvedActiveMode = isVideoFile ? "preview" : canPreview ? activeMode : "source";
  const assetPreviewPath = isBrowserFile || isImageFile || isVideoFile ? relativePath : null;
  const assetPreview = useWorkspaceFileAssetUrlState({
    cwd,
    environmentId,
    relativePath: assetPreviewPath,
    threadId,
  });
  const assetPreviewUri = assetPreview._tag === "Success" ? assetPreview.url : null;
  const mediaSource = useMemo<MediaActionsSource | undefined>(
    () =>
      environmentId !== null &&
      threadId !== null &&
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
            threadId,
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
      assetPreview.resource?._tag === "media-file"
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
  const needsFileContents =
    relativePath !== null &&
    !isVideoFile &&
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
      navigation.navigate("ThreadFile", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: path.split("/").filter(Boolean),
      });
    },
    [environmentId, navigation, threadId],
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
    const canToggleMode = canPreview && !isImageFile && !isVideoFile;
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
      ...(mediaSource
        ? mediaActions.actions
            .filter(({ id }) => id !== "open-file")
            .map((action) => ({
              id: action.id,
              title: action.title,
              icon:
                action.id === "share" ? ("square.and.arrow.up" as const) : ("doc.on.doc" as const),
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
      resolvedActiveMode === "preview" && (isBrowserFile || isImageFile || isVideoFile)
        ? ({
            id: "refresh",
            title: "Refresh",
            icon: "arrow.clockwise",
            inline: false,
            onPress: async () => {
              if (isVideoFile) await assetPreview.refresh();
              setPreviewRevision((current) => current + 1);
            },
          } as const)
        : null,
    ].filter((action) => action !== null);
  }, [
    assetPreviewUri,
    assetPreview.refresh,
    previewUri,
    canPreview,
    isBrowserFile,
    isImageFile,
    isVideoFile,
    relativePath,
    resolvedActiveMode,
    mediaSource,
    mediaActions.actions,
  ]);

  const androidFileMenuActions = useMemo<MenuAction[]>(
    () =>
      fileMenuActions.map((action) => ({
        id: action.id,
        title: action.title,
        image: action.icon,
        state: action.id === resolvedActiveMode ? "on" : undefined,
      })),
    [fileMenuActions, resolvedActiveMode],
  );
  const handleAndroidFileMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const action = fileMenuActions.find(({ id }) => id === event.nativeEvent.event);
      void action?.onPress();
    },
    [fileMenuActions],
  );
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

  if (selectedThread === null || environmentId === null || threadId === null) {
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

  const parentDir = relativePath.split("/").slice(0, -1).join("/");
  const headerSubtitle = [projectName, parentDir].filter(Boolean).join(" · ");

  return (
    <ReviewHighlighterProvider>
      <View className="flex-1 bg-sheet">
        <NativeStackScreenOptions
          options={{
            // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS: solid
            // sheet-colored header — this route's content scrolls internally, so
            // there is nothing for glass to sample). Only dynamic values here.
            headerShown: !isAndroid,
            headerTintColor: iconColor,
            headerTitle: basename(relativePath),
            title: basename(relativePath),
            unstable_headerSubtitle:
              Platform.OS === "ios" && headerSubtitle.length > 0 ? headerSubtitle : undefined,
          }}
        />
        {isAndroid ? (
          <AndroidScreenHeader
            title={basename(relativePath)}
            subtitle={headerSubtitle}
            onBack={handleBack}
            trailing={
              <>
                {fileInspector.supported ? (
                  <AndroidHeaderIconButton
                    accessibilityLabel={
                      panes.auxiliaryPaneVisible ? "Hide file navigator" : "Show file navigator"
                    }
                    icon="sidebar.right"
                    onPress={toggleAuxiliaryPane}
                  />
                ) : null}
                <ControlPillMenu
                  actions={androidFileMenuActions}
                  isAnchoredToRight
                  title="File actions"
                  onPressAction={handleAndroidFileMenuAction}
                >
                  <AndroidHeaderIconButton accessibilityLabel="File actions" icon="ellipsis" />
                </ControlPillMenu>
              </>
            }
          />
        ) : null}
        <WorkspaceSidebarToolbar>
          {fileInspector.supported ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel="Return to chat"
              icon="chevron.left"
              onPress={handleReturnToThread}
            />
          ) : null}
        </WorkspaceSidebarToolbar>
        <NativeHeaderToolbar placement="right">
          {fileInspector.supported ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel={
                panes.auxiliaryPaneVisible ? "Hide file navigator" : "Show file navigator"
              }
              icon="sidebar.right"
              onPress={toggleAuxiliaryPane}
              separateBackground
            />
          ) : null}
          <NativeHeaderToolbar.Menu accessibilityLabel="File actions" icon="ellipsis">
            {fileMenuActions.some(({ inline }) => inline) ? (
              <NativeHeaderToolbar.Menu inline>
                {fileMenuActions
                  .filter(({ inline }) => inline)
                  .map((action) => (
                    <NativeHeaderToolbar.MenuAction
                      key={action.id}
                      icon={action.icon}
                      isOn={action.id === resolvedActiveMode}
                      onPress={action.onPress}
                    >
                      {action.title}
                    </NativeHeaderToolbar.MenuAction>
                  ))}
              </NativeHeaderToolbar.Menu>
            ) : null}
            {fileMenuActions
              .filter(({ inline }) => !inline)
              .map((action) => (
                <NativeHeaderToolbar.MenuAction
                  key={action.id}
                  icon={action.icon}
                  onPress={action.onPress}
                >
                  {action.title}
                </NativeHeaderToolbar.MenuAction>
              ))}
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
        <FileContent
          key={previewKey}
          activeMode={resolvedActiveMode}
          previewUri={previewUri}
          previewUnavailable={assetPreview._tag === "Failure"}
          videoSource={videoSource}
          mediaSource={mediaSource}
          resolveVideoUri={assetPreview.refresh}
          fileContents={fileData?.contents ?? null}
          fileError={fileQuery.error}
          initialLine={targetLine}
          relativePath={relativePath}
          truncated={fileData?.truncated ?? false}
          onRefresh={() => fileQuery.refresh()}
        />
        <FilePreviewModal
          source={fullScreenPreview}
          onRequestClose={() => setFullScreenPreview(null)}
        />
      </View>
    </ReviewHighlighterProvider>
  );
}
