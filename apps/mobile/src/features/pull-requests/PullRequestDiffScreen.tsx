import { EnvironmentId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { type DiffLineKind } from "./pullRequestDiffParse";
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
  const file =
    path === undefined ? diff.files[0] : diff.files.find((entry) => entry.displayPath === path);
  const attemptedCursors = useRef(new Set<string>());
  const scopeKey = reference
    ? `${reference.projectId}:${reference.repository}:${reference.number}`
    : "";

  useEffect(() => {
    attemptedCursors.current = new Set();
  }, [scopeKey, path]);

  useEffect(() => {
    if (path === undefined || diff.loading || diff.loadingMore) return;
    if (file !== undefined) return;
    if (diff.nextCursor === null || attemptedCursors.current.has(diff.nextCursor)) return;
    attemptedCursors.current.add(diff.nextCursor);
    diff.loadMore();
  }, [diff.loading, diff.loadingMore, diff.loadMore, diff.nextCursor, file, path]);

  const title = file?.displayPath ?? path ?? "Diff";
  const waitingForSlice = file === undefined && (diff.loading || diff.loadingMore);

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
      ) : waitingForSlice ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={iconColor} />
        </View>
      ) : diff.error && file === undefined ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState title="Could not load this file" detail={diff.error} />
        </View>
      ) : file === undefined ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState
            title="File not in this diff"
            detail="This path was not in the loaded slices."
          />
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32 }}
          contentInsetAdjustmentBehavior="automatic"
          horizontal={false}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="min-w-full py-2">
              {file.lines.map((line, index) => (
                <View
                  key={`${index}:${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}`}
                  className={cn("flex-row px-3 py-0.5", LINE_CLASS[line.kind])}
                >
                  <Text className="w-10 font-mono text-2xs tabular-nums text-foreground-tertiary">
                    {line.oldLine ?? ""}
                  </Text>
                  <Text className="w-10 font-mono text-2xs tabular-nums text-foreground-tertiary">
                    {line.newLine ?? ""}
                  </Text>
                  <Text className={cn("font-mono text-xs", LINE_TEXT_CLASS[line.kind])}>
                    {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    {line.text}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </ScrollView>
      )}
    </View>
  );
}
