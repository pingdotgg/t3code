import type { EnvironmentId, ProjectListEntriesResult } from "@t3tools/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { useCallback, useMemo, useState, type ComponentProps } from "react";
import { Platform, Pressable, useColorScheme, View, type NativeSyntheticEvent } from "react-native";
import {
  Screen,
  ScreenStack,
  ScreenStackHeaderConfig,
  ScreenStackHeaderSearchBarView,
  SearchBar,
} from "react-native-screens";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useThemeColor } from "../../lib/useThemeColor";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";

export function ThreadFileNavigatorPane(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly headerInset: number;
  readonly projectName: string;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const colorScheme = useColorScheme();
  const highlightTheme = colorScheme === "dark" ? "dark" : "light";
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const sheetColor = String(useThemeColor("--color-sheet"));
  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
  const entriesQuery = useEnvironmentQuery(
    projectEnvironment.listEntries({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    }),
  );
  const entriesData = entriesQuery.data as ProjectListEntriesResult | null;
  const handlePreviewFile = useCallback(
    (relativePath: string) => {
      preloadWorkspaceFileContents({
        cwd: props.cwd,
        environmentId: props.environmentId,
        relativePath,
        theme: highlightTheme,
      });
    },
    [highlightTheme, props.cwd, props.environmentId],
  );
  const nativeHeaderRightBarButtonItems = useMemo(
    () =>
      [
        {
          accessibilityLabel: "Refresh files",
          icon: { name: "arrow.clockwise", type: "sfSymbol" as const },
          identifier: "thread-file-navigator-refresh",
          onPress: entriesQuery.refresh,
          sharesBackground: false,
          tintColor: foregroundColor,
          type: "button" as const,
          width: 44,
        },
      ] as ComponentProps<typeof ScreenStackHeaderConfig>["headerRightBarButtonItems"],
    [entriesQuery.refresh, foregroundColor],
  );

  const fileTree = (
    <FileTreeBrowser
      entries={entriesData?.entries ?? []}
      error={entriesQuery.error}
      isPending={entriesQuery.isPending}
      searchQuery={searchQuery}
      selectedPath={props.selectedPath}
      onPreviewFile={handlePreviewFile}
      onRefresh={entriesQuery.refresh}
      onSelectFile={props.onSelectFile}
    />
  );

  if (Platform.OS === "ios") {
    return (
      <View className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-file-navigator-native"
            scrollEdgeEffects={headerScrollEdgeEffects}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {fileTree}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              headerRightBarButtonItems={nativeHeaderRightBarButtonItems}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              subtitle={props.projectName}
              title="Files"
              titleColor={foregroundColor}
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            >
              <ScreenStackHeaderSearchBarView>
                <SearchBar
                  allowToolbarIntegration
                  autoCapitalize="none"
                  barTintColor={sheetColor}
                  hideNavigationBar={false}
                  hideWhenScrolling={false}
                  obscureBackground={false}
                  onCancelButtonPress={() => {
                    setSearchQuery("");
                  }}
                  onChangeText={(event: NativeSyntheticEvent<{ readonly text?: string }>) => {
                    setSearchQuery(event.nativeEvent.text ?? "");
                  }}
                  placement="integratedButton"
                  placeholder="Search files"
                  textColor={foregroundColor}
                  tintColor={foregroundColor}
                />
              </ScreenStackHeaderSearchBarView>
            </ScreenStackHeaderConfig>
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View className="flex-1 border-l border-border bg-sheet">
      <View className="border-b border-border" style={{ paddingTop: props.headerInset }}>
        <View className="h-12 flex-row items-center gap-2 px-3">
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-t3-bold text-foreground">Files</Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.projectName}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh files"
            hitSlop={8}
            className="h-8 w-8 items-center justify-center rounded-full active:bg-subtle"
            onPress={entriesQuery.refresh}
          >
            <SymbolView name="arrow.clockwise" size={14} tintColor={iconColor} type="monochrome" />
          </Pressable>
        </View>
        <View className="flex-row items-center gap-2 border-t border-border px-3 py-2">
          <SymbolView name="magnifyingglass" size={15} tintColor={iconColor} type="monochrome" />
          <TextInput
            accessibilityLabel="Search files"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            className="min-h-10 flex-1 rounded-xl py-2 text-sm"
            placeholder="Search files"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>
      {fileTree}
    </View>
  );
}
