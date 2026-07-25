import type { OrchestrationProposedPlan } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { isActionableProposedPlan } from "../../lib/proposedPlans";

const PLAN_PREVIEW_LINES = 8;

export interface ProposedPlanCardProps {
  readonly plan: OrchestrationProposedPlan;
  /** Whether the implement turn for this plan is currently being dispatched. */
  readonly implementing: boolean;
  readonly onImplement: (plan: OrchestrationProposedPlan) => void;
}

/**
 * A proposed plan rendered in the thread feed. Actionable plans offer an
 * "Implement plan" action that starts a turn sourced from the plan; already
 * implemented plans render read-only with an "Implemented" badge, mirroring
 * mac's PlanCard.
 */
export function ProposedPlanCard(props: ProposedPlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const actionable = isActionableProposedPlan(props.plan);

  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100/80 p-4 dark:border-white/6 dark:bg-neutral-900/80">
      <View className="flex-row items-center gap-2">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-accent">
          {actionable ? "Plan ready" : "Plan"}
        </Text>
        {!actionable ? (
          <View className="rounded-full bg-emerald-500/15 px-2 py-0.5 dark:bg-emerald-500/20">
            <Text className="font-t3-bold text-2xs text-emerald-700 dark:text-emerald-300">
              Implemented
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        numberOfLines={expanded ? undefined : PLAN_PREVIEW_LINES}
        className="font-sans text-sm leading-normal text-neutral-950 dark:text-neutral-50"
      >
        {props.plan.planMarkdown}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Show less" : "Show more"}
        onPress={() => setExpanded((value) => !value)}
        className="self-start"
      >
        <Text className="font-t3-medium text-xs text-neutral-500 dark:text-neutral-400">
          {expanded ? "Show Less" : "Show More"}
        </Text>
      </Pressable>
      {actionable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Implement plan"
          className={cn(
            "items-center justify-center rounded-2xl px-4 py-3.5",
            props.implementing ? "bg-neutral-200 dark:bg-neutral-700/60" : "bg-primary",
          )}
          disabled={props.implementing}
          onPress={() => props.onImplement(props.plan)}
        >
          <Text className="font-t3-extrabold text-sm text-primary-foreground">
            {props.implementing ? "Starting…" : "Implement plan"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
