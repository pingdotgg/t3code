import type { GitWorkflowProgress, GitWorkflowStep } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";

const stepColors: Record<GitWorkflowStep["state"], string> = {
  pending: "bg-subtle-strong",
  skipped: "bg-subtle-strong",
  running: "bg-primary",
  completed: "bg-emerald-500",
  failed: "bg-danger-foreground",
};
export function GitWorkflowProgressView({ progress }: { readonly progress: GitWorkflowProgress }) {
  const groups = new Map<string, GitWorkflowStep[]>();
  for (const step of progress.steps) {
    const group = groups.get(step.group) ?? [];
    group.push(step);
    groups.set(step.group, group);
  }
  const finished = progress.steps.filter(
    (step) => step.state === "completed" || step.state === "skipped",
  ).length;
  return (
    <View className="gap-3 rounded-xl bg-card p-4">
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={2} className="min-w-0 flex-1 text-sm text-foreground">
          {progress.state === "running"
            ? progress.kind === "stack"
              ? "Stack progress"
              : "Logical commits"
            : progress.label}
        </Text>
        <Text className="text-xs text-foreground-secondary">
          {finished}/{progress.steps.length} steps
        </Text>
      </View>
      {progress.kind === "stack" ? (
        <Text className="text-xs text-foreground-secondary">
          Rebase · Push · Hooks
          {progress.steps.some((step) => step.id.endsWith(":review")) ? " · Review" : ""}
        </Text>
      ) : null}
      {[...groups].map(([group, steps]) => (
        <View key={group} className="gap-1">
          {progress.kind === "stack" ? (
            <Text numberOfLines={1} className="text-xs text-foreground-secondary">
              {group}
            </Text>
          ) : null}
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={group}
            accessibilityValue={{
              min: 0,
              max: steps.length,
              now: steps.filter((step) => step.state === "completed" || step.state === "skipped")
                .length,
              text: steps.map((step) => `${step.label}: ${step.state}`).join(", "),
            }}
            className="flex-row gap-1"
          >
            {steps.map((step) => (
              <View
                key={step.id}
                className={cn("h-1.5 min-w-0 flex-1 rounded-sm", stepColors[step.state])}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}
