import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { PullRequestChangeBreakdown } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, View } from "react-native";
import Animated from "react-native-reanimated";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import type { ReviewParsedDiff, ReviewRenderableFile } from "../review/reviewModel";
import { PR_ROW_ENTER, PR_ROW_EXIT, PR_ROW_LAYOUT } from "./pullRequestAnimations";
import { PullRequestDiffStats, PullRequestReadStatus } from "./PullRequestPresentation";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import {
  pullRequestTarget,
  usePullRequestDiff,
  type PullRequestDiffParams,
  type PullRequestParams,
} from "./usePullRequestDiff";
import { usePullRequestFileFilter } from "./usePullRequestFileFilter";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";

const BREAKDOWN_LABELS = {
  code: "Code",
  tests: "Tests",
  mocks: "Mocks",
  generated: "Generated",
  docs: "Docs",
} satisfies Record<keyof NonNullable<PullRequestChangeBreakdown>, string>;

function fileDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function useChangedFiles(params: PullRequestDiffParams) {
  const detail = useEnvironmentQuery(composerPullRequests.detail(pullRequestTarget(params)));
  // A commit's diff is part of the pull request, so the PR's file counts and viewed state don't apply.
  const pr = params.commit ? null : detail.data;
  const terminology = sourceControlClients.get(
    (detail.data ?? params.initialSummary)?.provider,
  ).changeRequest;
  const diff = usePullRequestDiff(params, terminology);
  const viewed = usePullRequestFilesViewed(params, pr);
  const filter = usePullRequestFileFilter(diff.parsed);
  const parsed = filter.parsed;
  return {
    diff,
    filter,
    viewed,
    pr,
    terminology,
    parsed,
    loading: diff.isPending && parsed.kind === "empty" && !diff.error,
  };
}

type ChangedFiles = ReturnType<typeof useChangedFiles>;

function loadingRowCount(files: ChangedFiles) {
  return Math.min(files.pr?.changedFiles ?? 4, 6);
}

function describeFiles(
  parsed: Extract<ReviewParsedDiff, { readonly kind: "files" }>,
  { filter, viewed }: ChangedFiles,
) {
  const noun = (count: number) => (count === 1 ? "file" : "files");
  return [
    `${parsed.fileCount} ${filter.hiddenCount ? "visible" : "changed"} ${noun(parsed.fileCount)}`,
    viewed.supported
      ? `${parsed.files.filter((file) => viewed.isViewed(file.path)).length} viewed`
      : null,
    filter.hideTestFiles
      ? `${filter.hiddenCount} test ${noun(filter.hiddenCount)} hidden`
      : "Test files included",
  ]
    .filter(Boolean)
    .join(" · ");
}

function FileRow(props: {
  readonly file: ReviewRenderableFile;
  readonly viewed: boolean;
  /** Shown under the file name where files aren't grouped by directory. */
  readonly directory?: string;
  readonly onPress: () => void;
}) {
  const { file } = props;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`View diff for ${file.path}, ${file.additions} additions, ${file.deletions} deletions${props.viewed ? ", viewed" : ""}`}
      onPress={props.onPress}
      className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle py-3 active:opacity-70"
    >
      <PierreEntryIcon kind="file" path={file.path} size={20} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="footnote" className="font-t3-medium" numberOfLines={2}>
          {file.path.split("/").at(-1)}
        </Text>
        {props.directory ? (
          <Text textRole="caption" className="text-foreground-muted" numberOfLines={1}>
            {props.directory}
          </Text>
        ) : null}
        {file.previousPath ? (
          <Text textRole="caption" className="text-foreground-muted" numberOfLines={1}>
            Renamed from {file.previousPath}
          </Text>
        ) : null}
      </View>
      <PullRequestDiffStats additions={file.additions} deletions={file.deletions} compact />
      {props.viewed ? (
        <SymbolView
          name="checkmark.circle.fill"
          size={18}
          tintColorClassName="accent-adaptive-emerald-600-400"
        />
      ) : null}
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
    </RowPressable>
  );
}

function FileRowSkeleton(props: { readonly index: number }) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle py-3"
    >
      <View className="size-5 rounded-md bg-subtle-strong" />
      <View className="flex-1 gap-2">
        <View
          className="h-3.5 rounded bg-subtle-strong"
          style={{ width: props.index % 2 ? "65%" : "80%" }}
        />
        <View className="h-2.5 w-2/5 rounded bg-subtle-strong" />
      </View>
      <View className="h-3 w-7 rounded bg-subtle-strong" />
    </View>
  );
}

function FileFilterMenu({ filter }: { readonly filter: ChangedFiles["filter"] }) {
  return (
    <Menu
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
        <IconButton
          icon="line.3.horizontal.decrease"
          accessibilityLabel="Filter review files"
          selected={filter.hideTestFiles}
        />
      </View>
    </Menu>
  );
}

function NoVisibleFiles({ files }: { readonly files: ChangedFiles }) {
  const { diff, filter, parsed } = files;
  if (parsed.kind === "files") {
    return parsed.files.length === 0 && filter.hiddenCount > 0 ? (
      <EmptyState
        title={diff.nextCursor ? "No non-test files loaded yet" : "Only test files changed"}
        detail="Test files are hidden from this review."
        action={<Button label="Show test files" tone="contrast" onPress={filter.showAll} />}
        variant="plain"
      />
    ) : null;
  }
  return !diff.isPending && !diff.error ? (
    <Text textRole="footnote" className="py-6 text-foreground-muted">
      No text changes available.
    </Text>
  ) : null;
}

function FilesFooter({ files }: { readonly files: ChangedFiles }) {
  const { diff, viewed, parsed } = files;
  return (
    <>
      {diff.nextCursor ? (
        <Button
          label={diff.error ? "Retry loading files" : "Load more files"}
          tone="secondary"
          onPress={diff.error ? diff.refresh : diff.loadMore}
          loading={diff.isPending}
          fullWidth
        />
      ) : null}
      {viewed.error ? (
        <Text textRole="label" className="py-2 text-danger-foreground">
          {viewed.error}
        </Text>
      ) : null}
      {parsed.kind === "files" && parsed.notice ? (
        <Text textRole="label" className="py-4 text-foreground-muted">
          {parsed.notice}
        </Text>
      ) : null}
    </>
  );
}

function ChangeBreakdownLine(props: {
  readonly breakdown: NonNullable<PullRequestChangeBreakdown>;
}) {
  const parts = (Object.keys(BREAKDOWN_LABELS) as Array<keyof typeof BREAKDOWN_LABELS>).flatMap(
    (kind) => {
      const { additions, deletions } = props.breakdown[kind];
      return additions === 0 && deletions === 0
        ? []
        : [
            `${BREAKDOWN_LABELS[kind]} +${additions.toLocaleString()} −${deletions.toLocaleString()}`,
          ];
    },
  );
  return (
    <Text textRole="caption" className="tabular-nums text-foreground-muted" numberOfLines={2}>
      {parts.join(" · ")}
    </Text>
  );
}

/**
 * The changed-files section of the pull request overview. The overview tab is a single list,
 * so the section supplies its header, rows, and footer instead of rendering a list of its own.
 */
export function usePullRequestFilesSection(params: PullRequestParams) {
  const navigation = useNavigation();
  const files = useChangedFiles(params);
  const { diff, filter, viewed, pr, parsed, loading } = files;
  const breakdown = useEnvironmentQuery(
    composerPullRequests.changeBreakdown(pullRequestTarget(params)),
  ).data;
  const expected = pr ?? params.initialSummary;
  return {
    refresh: diff.refresh,
    header: (
      <>
        <PullRequestReadStatus pending={false} error={diff.error} terminology={files.terminology} />
        {loading ? (
          <View
            accessibilityLabel="Loading changed files"
            accessibilityState={{ busy: true }}
            className="min-h-17 flex-row items-center gap-2 py-3"
          >
            <View className="min-w-0 flex-1 gap-1">
              <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
              {pr ? (
                <Text textRole="caption" className="text-foreground-muted">
                  {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
                </Text>
              ) : (
                <View className="h-2.5 w-28 rounded bg-subtle-strong" />
              )}
            </View>
            {expected?.additions !== undefined && expected.deletions !== undefined ? (
              <PullRequestDiffStats
                additions={expected.additions}
                deletions={expected.deletions}
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
          <View className="min-h-17 flex-row items-center gap-2 py-3">
            <View className="min-w-0 flex-1 gap-1">
              <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
              <Text textRole="caption" className="text-foreground-muted">
                {describeFiles(parsed, files)}
              </Text>
              {breakdown ? <ChangeBreakdownLine breakdown={breakdown} /> : null}
            </View>
            <PullRequestDiffStats
              additions={parsed.additions}
              deletions={parsed.deletions}
              compact
            />
            <FileFilterMenu filter={filter} />
          </View>
        ) : null}
        <NoVisibleFiles files={files} />
      </>
    ),
    rows: loading
      ? Array.from({ length: loadingRowCount(files) }, (_, index) => ({
          key: `loading-file:${index}`,
          content: <FileRowSkeleton index={index} />,
        }))
      : (parsed.kind === "files" ? parsed.files : []).map((file) => ({
          key: file.id,
          content: (
            <FileRow
              file={file}
              directory={fileDirectory(file.path)}
              viewed={viewed.isViewed(file.path)}
              onPress={() => navigation.navigate("PullRequestFile", { ...params, path: file.path })}
            />
          ),
        })),
    footer: <FilesFooter files={files} />,
  };
}

type SheetItem =
  | {
      readonly kind: "directory";
      readonly key: string;
      readonly directory: string;
      readonly collapsed: boolean;
    }
  | { readonly kind: "file"; readonly key: string; readonly file: ReviewRenderableFile };

function groupByDirectory(
  files: ReadonlyArray<ReviewRenderableFile>,
  collapsed: ReadonlySet<string>,
) {
  const sorted = files
    .map((file) => ({ file, directory: fileDirectory(file.path) }))
    .sort(
      (a, b) => a.directory.localeCompare(b.directory) || a.file.path.localeCompare(b.file.path),
    );
  const items: SheetItem[] = [];
  sorted.forEach(({ file, directory }, index) => {
    if (directory !== sorted[index - 1]?.directory) {
      items.push({
        kind: "directory",
        key: `directory:${directory}`,
        directory,
        collapsed: collapsed.has(directory),
      });
    }
    if (!collapsed.has(directory)) items.push({ kind: "file", key: file.id, file });
  });
  return items;
}

function DirectoryRow(props: {
  readonly directory: string;
  readonly collapsed: boolean;
  readonly onPress: () => void;
}) {
  const label = props.directory || "Repository root";
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !props.collapsed }}
      onPress={props.onPress}
      className="min-h-11 flex-row items-center gap-2 pt-4 pb-2 active:opacity-70"
    >
      <SymbolView
        name={props.collapsed ? "chevron.right" : "chevron.down"}
        size={11}
        tintColorClassName="accent-icon-muted"
      />
      <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
      <Text textRole="label" className="min-w-0 flex-1 text-foreground-muted" numberOfLines={2}>
        {label}
      </Text>
    </RowPressable>
  );
}

/** The `PullRequestFiles` sheet: a changed-file picker presented over a file diff. */
export function PullRequestFilesSheet({ route }: StaticScreenProps<PullRequestDiffParams>) {
  const params = route.params;
  const navigation = useNavigation();
  const fileSelectionId = useRoute().key;
  const files = useChangedFiles(params);
  const { diff, filter, viewed, parsed, loading } = files;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [animationsReady, setAnimationsReady] = useState(false);
  const toggleDirectory = (directory: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(directory)) next.add(directory);
      return next;
    });
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        presentation={Platform.OS === "android" ? "inline" : "native"}
        title="Changed files"
        subtitle={`#${params.number} · ${params.commit?.slice(0, 7) ?? params.repository}`}
        onClose={() => navigation.goBack()}
        // iOS gets the native menu below; SheetHeader would render this as a custom bar item.
        trailing={Platform.OS === "android" ? <FileFilterMenu filter={filter} /> : undefined}
      />
      <Toolbar placement="right">
        <Toolbar.Menu
          title="Review files"
          accessibilityLabel="Filter review files"
          icon="line.3.horizontal.decrease"
        >
          <Toolbar.MenuAction
            icon="line.3.horizontal.decrease"
            isOn={filter.hideTestFiles}
            onPress={filter.toggle}
          >
            <Toolbar.Label>Hide test files</Toolbar.Label>
          </Toolbar.MenuAction>
        </Toolbar.Menu>
      </Toolbar>
      <ScreenContent>
        <AnimatedLegendList
          className="flex-1"
          data={parsed.kind === "files" ? groupByDirectory(parsed.files, collapsed) : []}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          itemLayoutAnimation={PR_ROW_LAYOUT}
          onLoad={() => setAnimationsReady(true)}
          renderItem={({ item }) => (
            <Animated.View
              entering={animationsReady ? PR_ROW_ENTER : undefined}
              exiting={animationsReady ? PR_ROW_EXIT : undefined}
            >
              {item.kind === "directory" ? (
                <DirectoryRow
                  directory={item.directory}
                  collapsed={item.collapsed}
                  onPress={() => toggleDirectory(item.directory)}
                />
              ) : (
                <FileRow
                  file={item.file}
                  viewed={viewed.isViewed(item.file.path)}
                  onPress={() =>
                    navigation.dispatch(
                      StackActions.popTo("PullRequestFile", {
                        ...params,
                        path: item.file.path,
                        fileSelectionId,
                      }),
                    )
                  }
                />
              )}
            </Animated.View>
          )}
          contentInsetAdjustmentBehavior="automatic"
          recycleItems={false}
          estimatedItemSize={64}
          ListHeaderComponent={
            <>
              <PullRequestReadStatus
                pending={false}
                error={diff.error}
                terminology={files.terminology}
              />
              {parsed.kind === "files" ? (
                <View className="flex-row items-center gap-2 py-2">
                  <Text textRole="caption" className="min-w-0 flex-1 text-foreground-muted">
                    {describeFiles(parsed, files)}
                  </Text>
                  <PullRequestDiffStats
                    additions={parsed.additions}
                    deletions={parsed.deletions}
                    compact
                  />
                </View>
              ) : null}
              <NoVisibleFiles files={files} />
            </>
          }
          ListEmptyComponent={
            loading ? (
              <View
                accessible
                accessibilityLabel="Loading changed files"
                accessibilityState={{ busy: true }}
              >
                {Array.from({ length: loadingRowCount(files) }, (_, index) => (
                  <FileRowSkeleton key={index} index={index} />
                ))}
              </View>
            ) : null
          }
          ListFooterComponent={<FilesFooter files={files} />}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
        />
      </ScreenContent>
    </View>
  );
}
