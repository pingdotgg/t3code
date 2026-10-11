import type { PullRequestListEntry } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { PullRequestStackCard } from "./PullRequestStackCard";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { pullRequestListReviewStatus } from "./pullRequestList";

export function PullRequestOverviewLoading({
  summary,
  params,
  stack,
}: {
  readonly summary: PullRequestListEntry;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const review = pullRequestListReviewStatus(summary);
  const conflicting = summary.mergeability === "conflicting";
  const clean = summary.mergeability === "mergeable";
  return (
    <View
      className="gap-5"
      accessibilityLabel="Loading pull request details"
      accessibilityState={{ busy: true }}
    >
      <PullRequestStackCard params={params} state={stack} />
      <PullRequestCardGroup>
        <PullRequestCardRow
          compact
          title={
            summary.checksState === "passing"
              ? "Checks completed"
              : summary.checksState === "failing"
                ? "Checks failing"
                : summary.checksState === "pending"
                  ? "Checks running"
                  : "Checks"
          }
          icon={
            summary.checksState === "passing"
              ? "checkmark.circle"
              : summary.checksState === "failing"
                ? "exclamationmark.circle"
                : "clock"
          }
          tint={
            summary.checksState === "passing"
              ? "accent-adaptive-emerald-600-400"
              : summary.checksState === "failing"
                ? "accent-danger-foreground"
                : "accent-icon-muted"
          }
        >
          <View className="h-3 w-16 rounded bg-subtle-strong" />
        </PullRequestCardRow>
        <PullRequestCardRow
          compact
          title={review?.accessibleLabel ?? "Reviews"}
          icon={review?.icon ?? "bubble.left"}
          tint={review?.tint}
        >
          <View className="h-3 w-20 rounded bg-subtle-strong" />
        </PullRequestCardRow>
        <PullRequestCardRow
          compact
          title={
            conflicting
              ? `Conflicts with ${summary.baseBranch}`
              : clean
                ? `No conflicts with ${summary.baseBranch}`
                : "Branch"
          }
          icon={
            conflicting ? "exclamationmark.triangle" : clean ? "checkmark.circle" : "arrow.branch"
          }
          tint={
            conflicting
              ? "accent-danger-foreground"
              : clean
                ? "accent-adaptive-emerald-600-400"
                : undefined
          }
        />
        <View className="border-t border-border-subtle p-3">
          <View className="h-11 rounded-xl bg-subtle-strong" />
        </View>
      </PullRequestCardGroup>
      {summary.labels.length ? (
        <View className="flex-row flex-wrap gap-2">
          {summary.labels.map((label) => (
            <View key={label.name} className="rounded-full bg-grouped-card px-3 py-1">
              <Text className="text-2xs text-foreground-muted">{label.name}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View className="gap-3">
        <Text className="text-base font-t3-semibold">Description</Text>
        <View className="gap-3 py-1">
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-3/4 rounded bg-subtle-strong" />
        </View>
      </View>
    </View>
  );
}
