import { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  parsedDiffFromContents,
  pullRequestDiffChangeType,
  pullRequestDiffContentsPaths,
  type DiffLineKind,
  type ParsedDiffFile,
  type ParsedDiffLine,
} from "./pullRequestDiffParse";
import { readableFailure } from "./pullRequestDetail.logic";
import { parseRoutePositiveInt, type PullRequestDiffRouteParams } from "./pullRequestNavigation";
import { usePullRequestDiffSlices } from "./usePullRequestDiffSlices";
import { useResolvedPullRequestReference } from "./useResolvedPullRequestReference";

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-emerald-500/12",
  del: "bg-red-500/12",
  hunk: "bg-subtle",
  meta: "bg-transparent",
  context: "bg-transparent",
};

const LINE_TEXT_CLASS: Record<DiffLineKind, string> = {
  add: "text-emerald-700 dark:text-emerald-300",
  del: "text-red-700 dark:text-red-300",
  hunk: "text-foreground-muted",
  meta: "text-foreground-tertiary",
  context: "text-foreground",
};

const DIFF_LINE_ESTIMATED_SIZE = 22;

type PullRequestDiffScreenProps = StaticScreenProps<PullRequestDiffRouteParams>;

export function PullRequestDiffScreen(props: PullRequestDiffScreenProps) {
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon");
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const number = parseRoutePositiveInt(props.route.params.number);
  const reference = useResolvedPullRequestReference(props.route.params);
  const path = props.route.params.path;
  const diff = usePullRequestDiffSlices({
    environmentId,
    reference,
    enabled: reference !== null,
  });
  const listed =
    path === undefined ? diff.files[0] : diff.files.find((entry) => entry.displayPath === path);
  const expanded = useExpandedWithheldDiffFile({
    environmentId,
    reference,
    file: listed,
  });
  const file = expanded.file ?? (listed?.withheld === true ? undefined : listed);
  const attemptedCursors = useRef(new Set<string>());
  const scopeKey = reference
    ? `${reference.projectId}:${reference.repository}:${reference.number}`
    : "";

  useEffect(() => {
    attemptedCursors.current = new Set();
  }, [scopeKey, path]);

  useEffect(() => {
    if (path === undefined || diff.loading || diff.loadingMore) return;
    if (listed !== undefined) return;
    if (diff.nextCursor === null || attemptedCursors.current.has(diff.nextCursor)) return;
    attemptedCursors.current.add(diff.nextCursor);
    diff.loadMore();
  }, [diff.loading, diff.loadingMore, diff.loadMore, diff.nextCursor, listed, path]);

  const title = listed?.displayPath ?? path ?? "Diff";
  const waitingForSlice = listed === undefined && (diff.loading || diff.loadingMore);
  const waitingForContents =
    listed?.withheld === true && expanded.file === null && expanded.error === null;
  const renderLine = useCallback(
    ({ item, index }: { item: ParsedDiffLine; index: number }) => (
      <DiffLineRow index={index} line={item} />
    ),
    [],
  );

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title }} />
      )}
      {number === null || reference === null ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState
            title="Pull request not found"
            detail="This link does not name a pull request."
          />
        </View>
      ) : waitingForSlice || waitingForContents ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={iconColor} />
        </View>
      ) : diff.error && listed === undefined ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState title="Could not load this file" detail={diff.error} />
        </View>
      ) : expanded.error !== null ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState title="Could not load this file" detail={expanded.error} />
        </View>
      ) : file === undefined ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState
            title="File not in this diff"
            detail="This path was not in the loaded slices."
          />
        </View>
      ) : (
        <LegendList
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}
          contentInsetAdjustmentBehavior="automatic"
          data={file.lines}
          estimatedItemSize={DIFF_LINE_ESTIMATED_SIZE}
          getItemType={(item) => item.kind}
          keyExtractor={(item, index) =>
            `${index}:${item.kind}:${item.oldLine ?? ""}:${item.newLine ?? ""}`
          }
          recycleItems
          renderItem={renderLine}
        />
      )}
    </View>
  );
}

function DiffLineRow(props: { readonly index: number; readonly line: ParsedDiffLine }) {
  const { line } = props;
  return (
    <View className={cn("flex-row px-3 py-0.5", LINE_CLASS[line.kind])}>
      <Text className="w-10 font-mono text-2xs tabular-nums text-foreground-tertiary">
        {line.oldLine ?? ""}
      </Text>
      <Text className="w-10 font-mono text-2xs tabular-nums text-foreground-tertiary">
        {line.newLine ?? ""}
      </Text>
      <Text className={cn("min-w-0 flex-1 font-mono text-xs", LINE_TEXT_CLASS[line.kind])}>
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
        {line.text}
      </Text>
    </View>
  );
}

function useExpandedWithheldDiffFile(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: ReturnType<typeof useResolvedPullRequestReference>;
  readonly file: ParsedDiffFile | undefined;
}) {
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents, {
    reportFailure: false,
  });
  const withheld = input.file?.withheld === true;
  const [file, setFile] = useState<ParsedDiffFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileKey = input.file?.key;

  useEffect(() => {
    if (input.reference === null || input.file === undefined || !withheld) {
      setFile(null);
      setError(null);
      return;
    }
    const listed = input.file;
    const reference = input.reference;
    let cancelled = false;
    setFile(null);
    setError(null);
    const paths = pullRequestDiffContentsPaths(listed);
    void getDiffFileContents({
      environmentId: input.environmentId,
      input: {
        ...reference,
        changeType: pullRequestDiffChangeType(listed),
        oldPath: paths.oldPath,
        newPath: paths.newPath,
      },
    }).then((result) => {
      if (cancelled) return;
      if (AsyncResult.isFailure(result)) {
        setError(
          readableFailure(
            squashAtomCommandFailure(result),
            "The host would not return the full contents of this file.",
          ),
        );
        return;
      }
      const expanded = parsedDiffFromContents(result.value.oldContents, result.value.newContents);
      setFile({
        ...listed,
        additions: expanded.additions,
        deletions: expanded.deletions,
        lines: expanded.lines,
        withheld: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fileKey, getDiffFileContents, input.environmentId, input.file, input.reference, withheld]);

  return { file, error };
}
