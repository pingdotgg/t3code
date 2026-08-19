import type { OrchestrationThreadGoalShell } from "@t3tools/contracts";
import {
  formatGoalChipPrefix,
  GOAL_PAUSE_HINT,
  goalChipActionLabel,
  goalChipActions,
  type GoalChipAction,
} from "@t3tools/shared/composerTrigger";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export type { GoalChipAction };

function goalStatusClass(status: string): string {
  if (status === "blocked") {
    return "text-red-600 dark:text-red-400";
  }
  if (status === "usageLimited") {
    return "text-amber-700 dark:text-amber-400";
  }
  return "text-foreground-muted";
}

export function GoalChip({
  goal,
  onAction,
}: {
  readonly goal: OrchestrationThreadGoalShell | null | undefined;
  readonly onAction?: ((action: GoalChipAction) => void) | undefined;
}) {
  if (goal == null) {
    return null;
  }

  const chipPrefix = formatGoalChipPrefix(goal.status);
  const actions = onAction == null ? [] : goalChipActions(goal.status);

  return (
    <View className="px-4 pb-2" accessibilityLabel={`${chipPrefix}: ${goal.objectivePreview}`}>
      <View className="self-start max-w-[80%] rounded-md border border-border bg-card px-2 py-1">
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          <Text className={`text-xs font-t3-medium ${goalStatusClass(goal.status)}`}>
            {chipPrefix}:
          </Text>
          {`  ${goal.objectivePreview}`}
        </Text>
        {actions.length > 0 ? (
          <View className="mt-1 flex-row flex-wrap gap-x-3 gap-y-1">
            {actions.map((action) => (
              <Pressable
                key={action}
                accessibilityRole="button"
                accessibilityLabel={goalChipActionLabel(action)}
                hitSlop={6}
                onPress={() => onAction?.(action)}
              >
                <Text
                  className={
                    action === "clear"
                      ? "text-xs text-red-600 dark:text-red-400"
                      : "text-xs text-foreground"
                  }
                >
                  {goalChipActionLabel(action)}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {goal.status === "active" ? (
          <Text className="mt-1 text-3xs text-foreground-muted">{GOAL_PAUSE_HINT}</Text>
        ) : null}
      </View>
    </View>
  );
}
