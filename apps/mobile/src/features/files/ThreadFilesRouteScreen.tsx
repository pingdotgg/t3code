import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  EnvironmentId,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
  ThreadId,
} from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { cn } from "../../lib/cn";
import { resolveFileSelectionNavigationAction } from "../../lib/adaptive-navigation";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { ReviewHighlighterProvider } from "../review/ReviewHighlighterProvider";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { SourceFileSurface } from "./SourceFileSurface";
import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";
import {
  basename,
  fileBreadcrumbs,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
} from "./filePath";
import { useWorkspaceFileAssetUrl } from "./workspaceFileAssetUrl";

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
  return path !== null && (isBrowserPreviewFile(path) || isImagePreviewFile(path))
    ? "preview"
    : "source";
}

function FileContent(props: {
  readonly activeMode: FileViewMode;
  readonly previewUri: string | null;
  readonly fileContents: string | null;
  readonly fileError: string | null;
  readonly relativePath: string;
  readonly initialLine: number | null;
  readonly truncated: boolean;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const isMarkdown = isMarkdownPreviewFile(props.relativePath);
  const isBrowserFile = isBrowserPreviewFile(props.relativePath);
  const isImageFile = isImagePreviewFile(props.relativePath);

  if (props.activeMode === "preview" && isImageFile) {
    if (isSvgImagePreviewFile(props.relativePath)) {
      return <WorkspaceFileWebPreview uri={props.previewUri} />;
    }
    return (
      <WorkspaceFileImagePreview
        accessibilityLabel={basename(props.relativePath)}
        uri={props.previewUri}
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
        <View className="border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900/60 dark:bg-amber-950/40">
          <Text className="text-2xs font-t3-bold uppercase text-amber-700 dark:text-amber-300">
            Partial file
          </Text>
          <Text className="text-xs leading-snug text-amber-800 dark:text-amber-200">
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
  const sheetColor = String(useThemeColor("--color-sheet"));

  if (process.env.EXPO_OS !== "ios") {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        bottom: 0,
        height: 112,
        left: 0,
        position: "absolute",
        right: 0,
        zIndex: 1,
      }}
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
  const colorScheme = useColorScheme();
  const highlightTheme = colorScheme === "dark" ? "dark" : "light";
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

  const usesCompactMailToolbar = Platform.OS === "ios" && !layout.usesSplitView;

  return (
    <>
      {/* Static header config (glass preset, title, contentStyle) lives in Stack.tsx.
          Only genuinely dynamic options are set here. */}
      <NativeStackScreenOptions
        options={{
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
      {layout.usesSplitView ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel={panes.primarySidebarVisible ? "Maximize files" : "Show threads"}
            icon={
              panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
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
  const iconColor = useThemeColor("--color-icon");
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
  const isBrowserFile = relativePath !== null && isBrowserPreviewFile(relativePath);
  const isImageFile = relativePath !== null && isImagePreviewFile(relativePath);
  const canPreview =
    relativePath !== null && (isMarkdownPreviewFile(relativePath) || isBrowserFile || isImageFile);
  const activeMode =
    relativePath !== null && modeOverride?.path === relativePath
      ? modeOverride.mode
      : defaultViewMode(relativePath);
  const resolvedActiveMode = canPreview ? activeMode : "source";
  const assetPreviewPath = isBrowserFile || isImageFile ? relativePath : null;
  const assetPreviewUri = useWorkspaceFileAssetUrl({
    cwd,
    environmentId,
    relativePath: assetPreviewPath,
    threadId,
  });
  const previewUri =
    assetPreviewUri === null || previewRevision === 0
      ? assetPreviewUri
      : `${assetPreviewUri}${assetPreviewUri.includes("?") ? "&" : "?"}revision=${previewRevision}`;
  const needsFileContents =
    relativePath !== null &&
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
            headerTintColor: iconColor,
            headerTitle: basename(relativePath),
            title: basename(relativePath),
            unstable_headerSubtitle:
              Platform.OS === "ios" && headerSubtitle.length > 0 ? headerSubtitle : undefined,
          }}
        />
        <WorkspaceSidebarToolbar>
          {fileInspector.supported ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel="Return to chat"
              icon="chevron.left"
              onPress={() => {
                navigation.dispatch(
                  StackActions.replace("Thread", {
                    environmentId: String(environmentId),
                    threadId: String(threadId),
                  }),
                );
              }}
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
            {canPreview && !isImageFile ? (
              <NativeHeaderToolbar.Menu inline>
                <NativeHeaderToolbar.MenuAction
                  icon="eye"
                  isOn={resolvedActiveMode === "preview"}
                  onPress={() => setModeOverride({ path: relativePath, mode: "preview" })}
                >
                  Preview
                </NativeHeaderToolbar.MenuAction>
                <NativeHeaderToolbar.MenuAction
                  icon="doc.text"
                  isOn={resolvedActiveMode === "source"}
                  onPress={() => setModeOverride({ path: relativePath, mode: "source" })}
                >
                  Source
                </NativeHeaderToolbar.MenuAction>
              </NativeHeaderToolbar.Menu>
            ) : null}
            <NativeHeaderToolbar.MenuAction
              icon="doc.on.doc"
              onPress={() => copyTextWithHaptic(relativePath)}
            >
              Copy path
            </NativeHeaderToolbar.MenuAction>
            {isBrowserFile && typeof assetPreviewUri === "string" ? (
              <NativeHeaderToolbar.MenuAction
                icon="safari"
                onPress={() => {
                  void tryOpenExternalUrl(assetPreviewUri, "file-preview");
                }}
              >
                Open in Safari
              </NativeHeaderToolbar.MenuAction>
            ) : null}
            {resolvedActiveMode === "preview" && (isBrowserFile || isImageFile) ? (
              <NativeHeaderToolbar.MenuAction
                icon="arrow.clockwise"
                onPress={() => {
                  setPreviewRevision((current) => current + 1);
                }}
              >
                Refresh
              </NativeHeaderToolbar.MenuAction>
            ) : null}
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
        <FileContent
          activeMode={resolvedActiveMode}
          previewUri={previewUri}
          fileContents={fileData?.contents ?? null}
          fileError={fileQuery.error}
          initialLine={targetLine}
          relativePath={relativePath}
          truncated={fileData?.truncated ?? false}
          onRefresh={() => fileQuery.refresh()}
        />
      </View>
    </ReviewHighlighterProvider>
  );
}
