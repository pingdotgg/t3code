import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo } from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { parseUnifiedDiff, type DiffLineKind } from "./pullRequestDiffParse";
import { parseRoutePositiveInt, type PullRequestDiffRouteParams } from "./pullRequestNavigation";

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
  const projectId = ProjectId.make(props.route.params.projectId);
  const number = parseRoutePositiveInt(props.route.params.number);
  const repository = props.route.params.repository;
  const path = props.route.params.path;
  const diffQuery = useEnvironmentQuery(
    number === null
      ? null
      : pullRequestEnvironment.diff({
          environmentId,
          input: { projectId, repository, number },
        }),
  );
  const files = useMemo(
    () => (diffQuery.data?.patch ? parseUnifiedDiff(diffQuery.data.patch) : []),
    [diffQuery.data],
  );
  const file = path === undefined ? files[0] : files.find((entry) => entry.displayPath === path);
  const title = file?.displayPath ?? path ?? "Diff";

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
      {diffQuery.isPending && file === undefined ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={iconColor} />
        </View>
      ) : diffQuery.error && file === undefined ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState title="Could not load this file" detail={diffQuery.error} />
        </View>
      ) : file === undefined ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState
            title="File not in this slice"
            detail="This path was not in the loaded diff."
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
