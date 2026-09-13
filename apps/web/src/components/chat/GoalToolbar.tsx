import type { ThreadGoal } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { PauseIcon, PencilIcon, PlayIcon, TargetIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

export function formatGoalDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m ${total % 60}s` : `${minutes}m ${total % 60}s`;
}

const goalStatusLabels: Record<ThreadGoal["status"], string> = {
  active: "Goaling",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Goal budget reached",
  complete: "Goal complete",
};

export function GoalToolbar(props: {
  goal: ThreadGoal;
  capability: { pause: boolean; tokenBudget: boolean } | undefined;
  disabled: boolean;
  onSet: (input: {
    objective?: string;
    status?: "active" | "paused";
    tokenBudget?: number | null;
  }) => Promise<boolean>;
  onClear: () => Promise<boolean>;
}) {
  const { goal } = props;
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState(goal.objective);
  const [budget, setBudget] = useState(goal.tokenBudget?.toString() ?? "");
  const [pending, setPending] = useState(false);
  const disabled = props.disabled || pending || !props.capability;
  const run = async (action: () => Promise<boolean>) => {
    setPending(true);
    try {
      if (await action()) setEditing(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        data-goal-toolbar="true"
        className="text-foreground before:border-purple-500/40"
      >
        <ComposerBanner.Row layout="wrap-actions">
          <ComposerBanner.Content className="flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
            <span
              role="status"
              className="inline-flex shrink-0 items-center gap-2 font-medium text-purple-700 dark:text-purple-300"
            >
              <TargetIcon className="size-3 translate-y-px shrink-0 text-purple-600 dark:text-purple-400" />
              {goalStatusLabels[goal.status]}
            </span>
            {goal.timeUsedSeconds !== null ? (
              <span className="tabular-nums" aria-label="Provider-reported goal run time">
                {formatGoalDuration(goal.timeUsedSeconds)}
              </span>
            ) : null}
            {goal.rounds !== undefined ? (
              <span className="tabular-nums">
                {goal.rounds} {goal.rounds === 1 ? "round" : "rounds"}
              </span>
            ) : null}
            {goal.tokensUsed !== null ? (
              <span className="ml-auto whitespace-nowrap text-purple-700 tabular-nums dark:text-purple-300">
                {formatTokens(goal.tokensUsed).replace("K", "k")}
                {goal.tokenBudget !== null
                  ? ` / ${formatTokens(goal.tokenBudget).replace("K", "k")}`
                  : ""}
                <span className="sr-only"> tokens</span>
              </span>
            ) : null}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-purple-700 dark:text-purple-300 [--control-icon-color:currentColor]"
              aria-label="Edit goal"
              disabled={disabled}
              onClick={() => {
                setObjective(goal.objective);
                setBudget(goal.tokenBudget?.toString() ?? "");
                setEditing(!editing);
              }}
            >
              <PencilIcon className="size-3" />
            </Button>
            {props.capability?.pause && goal.status !== "complete" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-purple-700 dark:text-purple-300 [--control-icon-color:currentColor]"
                disabled={disabled}
                aria-label={goal.status === "active" ? "Pause goal" : "Resume goal"}
                onClick={() =>
                  void run(() =>
                    props.onSet({ status: goal.status === "active" ? "paused" : "active" }),
                  )
                }
              >
                {goal.status === "active" ? (
                  <PauseIcon className="size-3" />
                ) : (
                  <PlayIcon className="size-3" />
                )}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-purple-700 dark:text-purple-300 [--control-icon-color:currentColor]"
              aria-label="Clear goal"
              disabled={disabled}
              onClick={() => void run(props.onClear)}
            >
              <XIcon className="size-3" />
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <div className="min-w-0 px-2 pb-1 pt-0.5 sm:pl-7">
          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Goal objective"
                value={objective}
                maxLength={4000}
                onChange={(event) => setObjective(event.target.value)}
                className="min-w-40 flex-1"
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                  if (event.key === "Escape") setEditing(false);
                }}
              />
              {props.capability?.tokenBudget ? (
                <Input
                  aria-label="Goal token budget"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Token budget"
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                  className="w-32"
                />
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={
                  disabled ||
                  !objective.trim() ||
                  (budget !== "" && (!Number.isSafeInteger(Number(budget)) || Number(budget) < 1))
                }
                onClick={() =>
                  void run(() =>
                    props.onSet({
                      objective: objective.trim(),
                      ...(props.capability?.tokenBudget
                        ? { tokenBudget: budget === "" ? null : Number(budget) }
                        : {}),
                    }),
                  )
                }
              >
                Save goal
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<p className="line-clamp-2 break-words" />}>
                {goal.objective}
              </TooltipTrigger>
              <TooltipPopup>{goal.objective}</TooltipPopup>
            </Tooltip>
          )}
          {goal.lastReason ? (
            <Tooltip>
              <TooltipTrigger render={<p className="mt-0.5 line-clamp-2 text-muted-foreground" />}>
                {goal.lastReason}
              </TooltipTrigger>
              <TooltipPopup>{goal.lastReason}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
