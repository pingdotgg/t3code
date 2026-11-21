import { Chip } from "../../components/ui/Chip";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import type { PullRequestListEntry, PullRequestSummary } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { PullRequestStackCard } from "./PullRequestStackCard";
import type { PullRequestParams } from "./usePullRequestDiff";
import type { PullRequestStackState } from "./usePullRequestStack";
import { pullRequestListReviewStatus } from "./pullRequestList";
import { PullRequestGlyph } from "./pullRequestGlyphs";

export function PullRequestOverviewLoading({
  summary,
  params,
  stack,
}: {
  readonly summary: PullRequestListEntry | PullRequestSummary;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const gt = useGT();
  const m = useMessages();
  const review = pullRequestListReviewStatus(
    {
      reviewDecision: summary.reviewDecision ?? undefined,
      viewerReviewRequested: "viewerReviewRequested" in summary && summary.viewerReviewRequested,
    },
    m,
  );
  const conflicting = summary.mergeability === "conflicting";
  const clean = summary.mergeability === "mergeable";
  return (
    <View
      className="gap-5"
      accessibilityLabel={gt("Loading pull request details")}
      accessibilityState={{ busy: true }}
    >
      <PullRequestStackCard params={params} state={stack} />
      <PullRequestCardGroup>
        <PullRequestCardRow
          compact
          title={
            summary.checksState === "passing"
              ? gt("Checks completed")
              : summary.checksState === "failing"
                ? gt("Checks failing")
                : summary.checksState === "pending"
                  ? gt("Checks running")
                  : gt("Checks", { $context: "CI checks row" })
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
          title={review?.accessibleLabel ?? gt("Reviews")}
          icon={review?.icon ?? "bubble.left"}
          tint={review?.tint}
        >
          <View className="h-3 w-20 rounded bg-subtle-strong" />
        </PullRequestCardRow>
        <PullRequestCardRow
          compact
          title={
            conflicting
              ? gt("Conflicts with {branch}", { branch: summary.baseBranch })
              : clean
                ? gt("No conflicts with {branch}", { branch: summary.baseBranch })
                : gt("Branch", { $context: "git branch" })
          }
          icon={
            conflicting ? PullRequestGlyph.conflicting : clean ? "checkmark.circle" : "arrow.branch"
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
      {"labels" in summary && summary.labels.length ? (
        <View className="flex-row flex-wrap gap-2">
          {summary.labels.map((label) => (
            <Chip key={label.name} label={label.name} size="small" />
          ))}
        </View>
      ) : null}
      <View className="gap-3">
        <PullRequestSectionHeading>
          <T>Description</T>
        </PullRequestSectionHeading>
        <View className="gap-3 py-1">
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-full rounded bg-subtle-strong" />
          <View className="h-4 w-3/4 rounded bg-subtle-strong" />
        </View>
      </View>
    </View>
  );
}
