import type { ActiveProposedPlan } from "@t3tools/client-runtime/proposed-plan";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  proposedPlanTitle,
} from "@t3tools/client-runtime/proposed-plan";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export interface ProposedPlanCardProps {
  readonly plan: ActiveProposedPlan;
  readonly implementing: boolean;
  readonly onImplement: (plan: ActiveProposedPlan) => void;
}

const PREVIEW_MAX_LINES = 12;

/**
 * The plan an agent left for a decision. Collapsed it reads like the feed's
 * other cards; expanded it shows the whole markdown so a phone-sized plan can
 * be reviewed without leaving the thread.
 */
export function ProposedPlanCard(props: ProposedPlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const title = proposedPlanTitle(props.plan.planMarkdown) ?? "Plan ready";
  const body = expanded
    ? props.plan.planMarkdown
    : buildCollapsedProposedPlanPreviewMarkdown(props.plan.planMarkdown, {
        maxLines: PREVIEW_MAX_LINES,
      });
  const canExpand = body.length < props.plan.planMarkdown.trimEnd().length;

  // Opaque like the approval cards: nothing blurs the feed behind this card,
  // so a translucent surface would bleed messages through it.
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Plan ready
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">{title}</Text>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">{body}</Text>
      {canExpand || expanded ? (
        <Pressable
          accessibilityRole="button"
          className="self-start rounded-[14px] bg-subtle-strong px-3.5 py-2"
          onPress={() => setExpanded((current) => !current)}
          disabled={props.implementing}
        >
          <Text className="font-t3-bold text-sm text-foreground">
            {expanded ? "Show less" : "Show full plan"}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        className="flex-row items-center justify-center gap-2 rounded-[14px] bg-primary px-3.5 py-3"
        disabled={props.implementing}
        onPress={() => props.onImplement(props.plan)}
      >
        {props.implementing ? (
          <ActivityIndicator size="small" />
        ) : (
          <Text className="font-t3-extrabold text-sm text-primary-foreground">Implement plan</Text>
        )}
      </Pressable>
    </View>
  );
}
