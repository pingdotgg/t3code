import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import Animated from "react-native-reanimated";
import { PR_ROW_LAYOUT, PR_ROW_ENTER, PR_ROW_EXIT } from "./pullRequestAnimations";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { Button } from "../../components/Button";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { SymbolView } from "../../components/AppSymbol";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { PullRequestDiffStats, PullRequestReadStatus } from "./PullRequestPresentation";
import {
  pullRequestTarget as requestTarget,
  usePullRequestDiff,
  type PullRequestDiffParams,
} from "./usePullRequestDiff";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { usePullRequestFileFilter } from "./usePullRequestFileFilter";

function fileDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function usePullRequestFilesContent(props: {
  readonly params: PullRequestDiffParams;
  readonly onSelectFile?: (path: string) => void;
  readonly groupByDirectory?: boolean;
}) {
  const navigation = useNavigation();
  const result = usePullRequestDiff(props.params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(props.params)));
  const viewed = usePullRequestFilesViewed(props.params, props.params.commit ? null : detail.data);
  const filter = usePullRequestFileFilter(result.parsed);
  const parsed = filter.parsed;
  const loading = result.isPending && parsed.kind === "empty" && !result.error;
  const fileCount = props.params.commit ? undefined : detail.data?.changedFiles;
  const summary = props.params.commit ? undefined : (detail.data ?? props.params.initialSummary);
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const files = parsed.kind === "files" ? parsed.files : [];
  const orderedFiles = props.groupByDirectory
    ? [...files].sort(
        (a, b) =>
          fileDirectory(a.path).localeCompare(fileDirectory(b.path)) ||
          a.path.localeCompare(b.path),
      )
    : files;
  const rows = orderedFiles.map((file, index) => {
    const directory = fileDirectory(file.path);
    const previousDirectory = fileDirectory(orderedFiles[index - 1]?.path ?? "");
    const showDirectory =
      props.groupByDirectory && (index === 0 || directory !== previousDirectory);
    const collapsed = props.groupByDirectory && collapsedDirectories.has(directory);
    if (collapsed && !showDirectory) return null;
    return {
      key: file.id,
      content: (
        <View>
          {showDirectory ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={directory || "Repository root"}
              accessibilityState={{ expanded: !collapsed }}
              onPress={() =>
                setCollapsedDirectories((current) => {
                  const next = new Set(current);
                  if (next.has(directory)) next.delete(directory);
                  else next.add(directory);
                  return next;
                })
              }
              className="min-h-11 flex-row items-center gap-2 pt-4 pb-2 active:opacity-70"
            >
              <SymbolView
                name={collapsed ? "chevron.right" : "chevron.down"}
                size={11}
                tintColorClassName="accent-icon-muted"
              />
              <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
                {directory || "Repository root"}
              </Text>
            </Pressable>
          ) : null}
          {!collapsed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View diff for ${file.path}, ${file.additions} additions, ${file.deletions} deletions`}
              onPress={() => {
                if (props.onSelectFile) props.onSelectFile(file.path);
                else
                  navigation.navigate("PullRequestFile", {
                    ...props.params,
                    path: file.path,
                  });
              }}
              className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle py-3 active:opacity-70"
            >
              <PierreEntryIcon kind="file" path={file.path} size={20} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-t3-medium text-foreground" numberOfLines={2}>
                  {file.path.split("/").at(-1)}
                </Text>
                {directory && !props.groupByDirectory ? (
                  <Text className="mt-0.5 text-2xs text-foreground-muted" numberOfLines={1}>
                    {directory}
                  </Text>
                ) : null}
                {file.previousPath ? (
                  <Text className="mt-0.5 text-2xs text-foreground-muted" numberOfLines={1}>
                    Renamed from {file.previousPath}
                  </Text>
                ) : null}
              </View>
              <PullRequestDiffStats additions={file.additions} deletions={file.deletions} compact />
              {viewed.isViewed(file.path) ? (
                <SymbolView
                  name="checkmark.circle.fill"
                  size={18}
                  tintColorClassName="accent-adaptive-emerald-600-400"
                />
              ) : null}
              <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
            </Pressable>
          ) : null}
        </View>
      ),
    };
  });
  return {
    refresh: result.refresh,
    rows: loading
      ? Array.from({ length: Math.min(fileCount ?? 4, 6) }, (_, index) => ({
          key: `loading-file:${index}`,
          content: (
            <View
              accessible={false}
              importantForAccessibility="no-hide-descendants"
              className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle py-3"
            >
              <View className="size-5 rounded-md bg-subtle-strong" />
              <View className="flex-1 gap-2">
                <View
                  className="h-3.5 rounded bg-subtle-strong"
                  style={{ width: index % 2 ? "65%" : "80%" }}
                />
                <View className="h-2.5 w-2/5 rounded bg-subtle-strong" />
              </View>
              <View className="h-3 w-7 rounded bg-subtle-strong" />
            </View>
          ),
        }))
      : rows.filter((row) => row !== null),
    header: (
      <>
        <PullRequestReadStatus pending={false} error={result.error} />
        {loading ? (
          <View
            accessibilityLabel="Loading changed files"
            accessibilityState={{ busy: true }}
            className="min-h-17 flex-row items-center gap-2 py-3"
          >
            <View className="min-w-0 flex-1 gap-1">
              <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
              {fileCount !== undefined ? (
                <Text className="text-2xs text-foreground-muted">
                  {fileCount} {fileCount === 1 ? "file" : "files"}
                </Text>
              ) : (
                <View className="h-2.5 w-28 rounded bg-subtle-strong" />
              )}
            </View>
            {summary?.additions !== undefined && summary.deletions !== undefined ? (
              <PullRequestDiffStats
                additions={summary.additions}
                deletions={summary.deletions}
                compact
              />
            ) : null}
            <View className="size-11 items-center justify-center opacity-40">
              <SymbolView
                name="line.3.horizontal.decrease"
                size={20}
                tintColorClassName="accent-icon-muted"
              />
            </View>
          </View>
        ) : parsed.kind === "files" ? (
          <>
            <View className="min-h-17 flex-row items-center gap-2 py-3">
              <View className="min-w-0 flex-1 gap-1">
                <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
                <Text className="text-2xs text-foreground-muted">
                  {parsed.fileCount} {filter.hiddenCount ? "visible" : "changed"}{" "}
                  {parsed.fileCount === 1 ? "file" : "files"}
                  {viewed.supported
                    ? ` · ${parsed.files.filter((file) => viewed.isViewed(file.path)).length} viewed`
                    : ""}
                  {" · "}
                  {filter.hideTestFiles
                    ? `${filter.hiddenCount} test ${filter.hiddenCount === 1 ? "file" : "files"} hidden`
                    : "Test files included"}
                </Text>
              </View>
              <PullRequestDiffStats
                additions={parsed.additions}
                deletions={parsed.deletions}
                compact
              />
              <ControlPillMenu
                title="Review files"
                actions={[
                  {
                    id: "hide-tests",
                    title: "Hide test files",
                    image: "line.3.horizontal.decrease",
                    state: filter.hideTestFiles ? "on" : "off",
                  },
                ]}
                onPressAction={filter.toggle}
              >
                <View pointerEvents="none">
                  <MaterialIconButton
                    icon="line.3.horizontal.decrease"
                    accessibilityLabel="Filter review files"
                    selected={filter.hideTestFiles}
                  />
                </View>
              </ControlPillMenu>
            </View>
            {parsed.files.length === 0 && filter.hiddenCount > 0 ? (
              <EmptyState
                title={
                  result.nextCursor ? "No non-test files loaded yet" : "Only test files changed"
                }
                detail="Test files are hidden from this review."
                action={<Button label="Show test files" tone="contrast" onPress={filter.showAll} />}
                variant="plain"
              />
            ) : null}
          </>
        ) : !result.isPending && !result.error ? (
          <Text className="py-6 text-sm text-foreground-muted">No text changes available.</Text>
        ) : null}
      </>
    ),
    footer: (
      <>
        {result.nextCursor ? (
          <Pressable
            onPress={result.error ? result.refresh : result.loadMore}
            accessibilityRole="button"
            className="min-h-11 items-center justify-center rounded-xl bg-grouped-card px-4 py-3"
          >
            {result.isPending ? (
              <ActivityIndicator />
            ) : (
              <Text className="text-sm font-t3-medium">
                {result.error ? "Retry loading files" : "Load more files"}
              </Text>
            )}
          </Pressable>
        ) : null}
        {viewed.error ? (
          <Text className="py-2 text-xs text-danger-foreground">{viewed.error}</Text>
        ) : null}
        {parsed.kind === "files" && parsed.notice ? (
          <Text className="py-4 text-xs text-foreground-muted">{parsed.notice}</Text>
        ) : null}
      </>
    ),
  };
}

export function PullRequestFiles(props: Parameters<typeof usePullRequestFilesContent>[0]) {
  const content = usePullRequestFilesContent(props);
  const [animationsReady, setAnimationsReady] = useState(false);
  return (
    <AnimatedLegendList
      data={content.rows}
      keyExtractor={(row) => row.key}
      itemLayoutAnimation={PR_ROW_LAYOUT}
      onLoad={() => setAnimationsReady(true)}
      renderItem={({ item }) => (
        <Animated.View
          key={item.key}
          entering={animationsReady ? PR_ROW_ENTER : undefined}
          exiting={animationsReady ? PR_ROW_EXIT : undefined}
        >
          {item.content}
        </Animated.View>
      )}
      recycleItems={false}
      estimatedItemSize={64}
      ListHeaderComponent={content.header}
      ListFooterComponent={content.footer}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
    />
  );
}
