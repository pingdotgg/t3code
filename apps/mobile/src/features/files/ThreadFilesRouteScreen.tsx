import Stack from "expo-router/stack";
import { SymbolView } from "expo-symbols";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text as RNText,
  useColorScheme,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  EnvironmentId,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
  ThreadId,
} from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { cn } from "../../lib/cn";
import { resolveFileSelectionNavigationAction } from "../../lib/adaptive-navigation";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { buildThreadFilesNavigation, buildThreadRoutePath } from "../../lib/routes";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { AdaptiveInspectorLayout } from "../layout/adaptive-inspector-layout";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
} from "../layout/AdaptiveWorkspaceLayout";
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

function ModeButton(props: {
  readonly active: boolean;
  readonly icon: "doc.text" | "eye";
  readonly label: string;
  readonly onPress: () => void;
}) {
  const iconColor = String(
    useThemeColor(props.active ? "--color-primary-foreground" : "--color-icon-muted"),
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      className={cn(
        "h-8 flex-row items-center justify-center gap-1.5 rounded-full px-3 active:opacity-70",
        props.active ? "bg-primary" : "bg-subtle",
      )}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={13} tintColor={iconColor} type="monochrome" />
      <Text
        className={cn(
          "text-xs font-t3-bold",
          props.active ? "text-primary-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function BreadcrumbFade(props: { readonly color: string; readonly side: "left" | "right" }) {
  const gradientId = `file-breadcrumb-${props.side}-fade`;
  const isLeft = props.side === "left";

  return (
    <View
      pointerEvents="none"
      className={cn("absolute inset-y-0 w-7", isLeft ? "left-0" : "right-0")}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor={props.color} stopOpacity={isLeft ? 1 : 0} />
            <Stop offset="100%" stopColor={props.color} stopOpacity={isLeft ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
}

function FileBreadcrumbs(props: { readonly projectName: string; readonly relativePath: string }) {
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const cardColor = String(useThemeColor("--color-card"));
  const scrollMetrics = useRef({ contentWidth: 0, offsetX: 0, viewportWidth: 0 });
  const [fadeVisibility, setFadeVisibility] = useState({ left: false, right: false });
  const breadcrumbs = useMemo(
    () => fileBreadcrumbs(props.projectName, props.relativePath),
    [props.projectName, props.relativePath],
  );
  const updateFadeVisibility = useCallback(
    (metrics: Partial<(typeof scrollMetrics)["current"]>) => {
      Object.assign(scrollMetrics.current, metrics);
      const { contentWidth, offsetX, viewportWidth } = scrollMetrics.current;
      const maxOffset = Math.max(0, contentWidth - viewportWidth);
      const next = {
        left: maxOffset > 1 && offsetX > 1,
        right: maxOffset > 1 && offsetX < maxOffset - 1,
      };

      setFadeVisibility((current) =>
        current.left === next.left && current.right === next.right ? current : next,
      );
    },
    [],
  );

  return (
    <View className="min-w-0 flex-1">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onContentSizeChange={(contentWidth) => {
          updateFadeVisibility({ contentWidth });
        }}
        onLayout={(event) => {
          updateFadeVisibility({ viewportWidth: event.nativeEvent.layout.width });
        }}
        onScroll={(event) => {
          updateFadeVisibility({ offsetX: event.nativeEvent.contentOffset.x });
        }}
        scrollEventThrottle={16}
      >
        <View className="h-8 flex-row items-center">
          {breadcrumbs.map((crumb, index) => (
            <View key={crumb.path || "project"} className="flex-row items-center">
              {index > 0 ? (
                <SymbolView
                  name="chevron.right"
                  size={10}
                  tintColor={iconColor}
                  type="monochrome"
                />
              ) : null}
              <Text
                className={cn(
                  "max-w-[180px] px-1 text-xs",
                  crumb.kind === "file"
                    ? "font-t3-bold text-foreground"
                    : "font-t3-medium text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {crumb.label}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      {fadeVisibility.left ? <BreadcrumbFade color={cardColor} side="left" /> : null}
      {fadeVisibility.right ? <BreadcrumbFade color={cardColor} side="right" /> : null}
    </View>
  );
}

function FilePreviewHeader(props: {
  readonly activeMode: FileViewMode;
  readonly showModeSelector: boolean;
  readonly externalPreviewUri?: string | null;
  readonly projectName: string;
  readonly relativePath: string;
  readonly onSetMode: (mode: FileViewMode) => void;
}) {
  const iconColor = String(useThemeColor("--color-icon-muted"));

  return (
    <View className="border-b border-border bg-card px-3 py-2">
      <View className="flex-row items-center gap-2">
        <FileBreadcrumbs projectName={props.projectName} relativePath={props.relativePath} />
        <CopyTextButton
          accessibilityLabel="Copy file path"
          text={props.relativePath}
          tintColor={iconColor}
          buttonSize={32}
          iconSize={13}
        />
      </View>
      {props.showModeSelector ? (
        <View className="mt-2 flex-row items-center gap-2">
          <ModeButton
            active={props.activeMode === "preview"}
            icon="eye"
            label="Preview"
            onPress={() => props.onSetMode("preview")}
          />
          <ModeButton
            active={props.activeMode === "source"}
            icon="doc.text"
            label="Source"
            onPress={() => props.onSetMode("source")}
          />
          {props.externalPreviewUri !== undefined ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open preview in Safari"
              disabled={props.externalPreviewUri === null}
              hitSlop={8}
              className={cn(
                "ml-auto h-8 w-8 items-center justify-center rounded-full bg-subtle active:opacity-70",
                props.externalPreviewUri === null && "opacity-40",
              )}
              onPress={() => {
                if (typeof props.externalPreviewUri === "string") {
                  void tryOpenExternalUrl(props.externalPreviewUri, "file-preview");
                }
              }}
            >
              <SymbolView name="safari" size={15} tintColor={iconColor} type="monochrome" />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function FileContent(props: {
  readonly activeMode: FileViewMode;
  readonly previewUri: string | null;
  readonly fileContents: string | null;
  readonly fileError: string | null;
  readonly relativePath: string;
  readonly initialLine: number | null;
  readonly truncated: boolean;
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
      <View className="flex-1 items-center justify-center bg-card px-6">
        <EmptyState title="File unavailable" detail={props.fileError} />
      </View>
    );
  }

  if (props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Loading file...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-card">
      {props.truncated ? (
        <View className="border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900/60 dark:bg-amber-950/40">
          <Text className="text-2xs font-t3-bold uppercase text-amber-700 dark:text-amber-300">
            Partial file
          </Text>
          <Text className="text-xs leading-[17px] text-amber-800 dark:text-amber-200">
            Preview limited to the first 1 MB of a truncated file.
          </Text>
        </View>
      ) : null}
      {props.activeMode === "preview" && isMarkdown ? (
        <FileMarkdownPreview markdown={props.fileContents} />
      ) : (
        <SourceFileSurface
          contents={props.fileContents}
          path={props.relativePath}
          initialLine={props.initialLine}
        />
      )}
    </View>
  );
}

function useThreadFilesWorkspace() {
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
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
      <Stack.Screen options={{ title: "Files" }} />
      <EmptyState
        title="Files unavailable"
        detail="This thread does not have an active workspace path."
      />
    </View>
  );
}

function FilesHeaderTitle(props: { readonly projectName: string }) {
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const secondaryForegroundColor = String(useThemeColor("--color-foreground-secondary"));

  return (
    <View style={{ alignItems: "center", maxWidth: 220 }}>
      <RNText
        numberOfLines={1}
        style={{
          color: foregroundColor,
          fontFamily: "DMSans_700Bold",
          fontSize: MOBILE_TYPOGRAPHY.headline.fontSize,
          fontWeight: "900",
          letterSpacing: -0.4,
        }}
      >
        Files
      </RNText>
      <RNText
        numberOfLines={1}
        style={{
          color: secondaryForegroundColor,
          fontFamily: "DMSans_500Medium",
          fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
          fontWeight: "500",
          letterSpacing: 0.2,
        }}
      >
        {props.projectName}
      </RNText>
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

export function ThreadFilesTreeScreen() {
  useAdaptiveWorkspacePaneRole("inspector");
  const router = useRouter();
  const { fileInspector, layout, panes, showAuxiliaryPane, togglePrimarySidebar } =
    useAdaptiveWorkspaceLayout();
  const [searchQuery, setSearchQuery] = useState("");
  const colorScheme = useColorScheme();
  const highlightTheme = colorScheme === "dark" ? "dark" : "light";
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace();
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
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (environmentId !== null && threadId !== null) {
      router.replace(buildThreadRoutePath({ environmentId, threadId }));
    }
  }, [environmentId, router, threadId]);

  const handleSelectFile = useCallback(
    (path: string) => {
      if (environmentId === null || threadId === null) {
        return;
      }
      const destination = buildThreadFilesNavigation({ environmentId, threadId }, path);
      const navigationAction = resolveFileSelectionNavigationAction({
        hasPersistentFileInspector: fileInspector.supported,
      });
      if (navigationAction === "replace") {
        router.replace(destination);
        return;
      }
      router.push(destination);
    },
    [environmentId, fileInspector.supported, router, threadId],
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
  const renderHeaderTitle = useCallback(
    () => <FilesHeaderTitle projectName={projectName} />,
    [projectName],
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
      />
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <Stack.Screen
        options={{
          title: "Files",
          headerShown: true,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          headerShadowVisible: false,
          headerTitle: renderHeaderTitle,
          headerSearchBarOptions: {
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
      <Stack.Toolbar placement="right">
        {layout.usesSplitView ? (
          <Stack.Toolbar.Button
            accessibilityLabel={
              panes.primarySidebarVisible ? "Maximize files" : "Show thread sidebar"
            }
            icon={
              panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
            }
            onPress={togglePrimarySidebar}
            separateBackground
          />
        ) : null}
        <Stack.Toolbar.Button
          accessibilityLabel="Refresh files"
          icon="arrow.clockwise"
          onPress={entriesQuery.refresh}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.SearchBarSlot />
      </Stack.Toolbar>
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
    </View>
  );
}

export function ThreadFileScreen() {
  useAdaptiveWorkspacePaneRole("inspector");
  const router = useRouter();
  const { fileInspector, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const params = useLocalSearchParams<{
    line?: string | string[];
    path?: string | string[];
  }>();
  const relativePath = normalizeRoutePath(params.path);
  const targetLine = normalizeRouteLine(firstRouteParam(params.line));
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace();
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
      // We are already on the catch-all file route. Updating its params keeps
      // the current native screen mounted while replacing the selected file in
      // place, avoiding an RNSScreen snapshot/unmount for every tree click.
      router.setParams({
        line: undefined,
        path: path.split("/").filter(Boolean),
      });
    },
    [router],
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

  if (selectedThread === null || environmentId === null || threadId === null) {
    return <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />;
  }

  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (relativePath === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <Stack.Screen options={{ title: "Files" }} />
        <EmptyState title="File unavailable" detail="This file path is invalid." />
      </View>
    );
  }

  return (
    <ReviewHighlighterProvider>
      <View className="flex-1 bg-sheet">
        <Stack.Screen
          options={{ headerTitle: basename(relativePath), title: basename(relativePath) }}
        />
        <WorkspaceSidebarToolbar>
          {fileInspector.supported ? (
            <Stack.Toolbar.Button
              accessibilityLabel="Return to chat"
              icon="chevron.left"
              onPress={() => {
                router.replace(buildThreadRoutePath({ environmentId, threadId }));
              }}
            />
          ) : null}
        </WorkspaceSidebarToolbar>
        <Stack.Toolbar placement="right">
          {fileInspector.supported ? (
            <Stack.Toolbar.Button
              accessibilityLabel={
                panes.auxiliaryPaneVisible ? "Hide file navigator" : "Show file navigator"
              }
              icon="sidebar.right"
              onPress={toggleAuxiliaryPane}
              separateBackground
            />
          ) : null}
          <Stack.Toolbar.Button
            accessibilityLabel="Refresh file"
            icon="arrow.clockwise"
            onPress={() => {
              if (resolvedActiveMode === "preview" && (isBrowserFile || isImageFile)) {
                setPreviewRevision((current) => current + 1);
                return;
              }
              fileQuery.refresh();
            }}
          />
        </Stack.Toolbar>
        <AdaptiveInspectorLayout
          renderInspector={fileInspector.supported ? () => renderInspector(0) : undefined}
        >
          <FilePreviewHeader
            activeMode={resolvedActiveMode}
            showModeSelector={canPreview && !isImageFile}
            externalPreviewUri={isBrowserFile ? assetPreviewUri : undefined}
            projectName={projectName}
            relativePath={relativePath}
            onSetMode={(mode) => {
              setModeOverride({ path: relativePath, mode });
            }}
          />
          <FileContent
            activeMode={resolvedActiveMode}
            previewUri={previewUri}
            fileContents={fileData?.contents ?? null}
            fileError={fileQuery.error}
            initialLine={targetLine}
            relativePath={relativePath}
            truncated={fileData?.truncated ?? false}
          />
        </AdaptiveInspectorLayout>
      </View>
    </ReviewHighlighterProvider>
  );
}
