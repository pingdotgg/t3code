import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useState } from "react";
import { View } from "react-native";

import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { NativeInspectorContent } from "../../native/NativeInspectorContent";
import { useFileTreeEntries } from "./useFileTreeEntries";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";

export function ThreadFileNavigatorPane(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly projectName: string;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const fileAccessSession = useEnvironmentQuery(
    environmentSession.sessionStateAtom(props.environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(props.environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const entriesQuery = useFileTreeEntries({
    environmentId: props.environmentId,
    cwd: canReadFiles ? props.cwd : null,
    searchQuery,
  });
  const handlePreviewFile = (relativePath: string) => {
    preloadWorkspaceFileContents({
      cwd: props.cwd,
      environmentId: props.environmentId,
      relativePath,
      theme: highlightTheme,
    });
  };
  const fileTree = (
    <FileTreeBrowser
      key={JSON.stringify([props.environmentId, props.cwd])}
      revealSelection={entriesQuery.revealSelection}
      expandedPaths={entriesQuery.expandedPaths}
      setExpandedPaths={entriesQuery.setExpandedPaths}
      entries={entriesQuery.entries}
      loadingDirectories={entriesQuery.loadingDirectories}
      onLoadDirectory={entriesQuery.loadDirectory}
      error={
        canReadFiles
          ? entriesQuery.error
          : fileAccess.isPending
            ? null
            : (fileAccess.error ?? "This connection cannot read host files.")
      }
      isPending={fileAccess.isPending || entriesQuery.isPending}
      isRefreshing={entriesQuery.isRefreshing}
      searchQuery={searchQuery}
      searchResultPaths={entriesQuery.searchResultPaths}
      searchTruncated={entriesQuery.searchTruncated}
      selectedPath={props.selectedPath ?? entriesQuery.selectedPath}
      onPreviewFile={handlePreviewFile}
      onRefresh={entriesQuery.refresh}
      onSelectFile={(path) => {
        entriesQuery.selectPath(path);
        props.onSelectFile(path);
      }}
    />
  );

  return (
    <View className="flex-1 ios:bg-sheet android:bg-header">
      <AppBar
        title="Files"
        subtitle={props.projectName}
        search={{
          value: searchQuery,
          onChangeText: setSearchQuery,
          placeholder: "Search files",
          onRefresh: entriesQuery.refresh,
          refreshAccessibilityLabel: "Refresh files",
          refreshInToolbar: true,
        }}
      />
      <ScreenContent insetHorizontal>
        <NativeInspectorContent>{fileTree}</NativeInspectorContent>
      </ScreenContent>
    </View>
  );
}
