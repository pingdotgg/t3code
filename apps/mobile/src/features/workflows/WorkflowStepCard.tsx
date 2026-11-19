import {
  buildWorkflowFeed,
  buildWorkflowTimeline,
  workflowAgentSummary,
  workflowAnswer,
  type WorkflowBeat,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowStep } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";

export function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  Dialog.alert(title, String(squashAtomCommandFailure(result)));
}

/** Markdown's emphasis marks, which plain text would show as asterisks and backticks. */
export const plain = (text: string) => text.replace(/\*\*|__|`/g, "");

export function Card(props: { readonly tone?: "input" | "failed"; readonly children: ReactNode }) {
  return (
    <View
      className={cn(
        "gap-2 rounded-2xl border p-4",
        props.tone === "input"
          ? "border-primary bg-primary/5"
          : props.tone === "failed"
            ? "border-danger-border bg-danger/5"
            : "border-border bg-card",
      )}
    >
      {props.children}
    </View>
  );
}

export function Facts(props: {
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}) {
  if (props.facts.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {props.facts.map((fact) => (
        <View key={fact.label} className="max-w-full flex-row gap-1 rounded-md bg-subtle px-2 py-1">
          <Text className="text-xs text-foreground-muted">{fact.label}</Text>
          <Text className="shrink font-t3-medium text-xs text-foreground">{fact.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** All of one step, as its sheet shows it: what it said, its facts, and where to read more. */
export function BeatCard(props: {
  readonly beat: WorkflowBeat;
  readonly onOpenThread: (thread: NonNullable<WorkflowBeat["thread"]>) => void;
  readonly onOpenRun: (runId: string) => void;
}) {
  const { beat } = props;
  const thread = beat.thread;
  const child = beat.childRun;
  const summary = workflowAgentSummary(beat);
  const answer = beat.kind === "ask" ? workflowAnswer(beat.result) : null;
  const running = beat.status === "running";
  const gt = useGT();
  return (
    <Card>
      <View className="flex-row items-center gap-2">
        {/* The sheet's title names the step. */}
        <View className="flex-1" />
        <Text
          className={cn(
            "text-xs",
            beat.status === "failed" ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {running
            ? gt("Working", { $context: "workflow step status" })
            : beat.status === "failed"
              ? gt("Failed", { $context: "workflow step status" })
              : gt("Done", { $context: "workflow step status" })}
        </Text>
      </View>
      {answer === null ? null : (
        <Text className="text-sm text-foreground">
          {answer.reason === null
            ? gt("Answered {choice}", { choice: answer.choice })
            : gt("Answered {choice}: {reason}", { choice: answer.choice, reason: answer.reason })}
        </Text>
      )}
      {child === null ? null : (
        <Text className="text-sm text-foreground-secondary" numberOfLines={2}>
          {child.title}
        </Text>
      )}
      {summary.said === null ? null : (
        <Text className="text-sm text-foreground">{plain(summary.said)}</Text>
      )}
      {beat.status === "failed" && beat.detail !== null ? (
        <Text className="text-sm text-danger-foreground">{beat.detail}</Text>
      ) : null}
      {answer === null ? <Facts facts={summary.facts} /> : null}
      {thread === null && child === null ? null : (
        <View className="flex-row gap-2 pt-1">
          {thread === null ? null : (
            <Button
              size="compact"
              label={
                running
                  ? gt("Watch live")
                  : gt("Transcript", { $context: "button, opens the agent's conversation" })
              }
              onPress={() => props.onOpenThread(thread)}
            />
          )}
          {child === null ? null : (
            <Button
              size="compact"
              label={gt("Open run")}
              onPress={() => props.onOpenRun(child.runId)}
            />
          )}
        </View>
      )}
    </Card>
  );
}

/**
 * A run's steps in the order they are read. The clock is the run's own: a finished step's times
 * are fixed, and one under way ends at the run's last change, which is exact enough for an order.
 */
export const workflowRunFeedOf = (node: WorkflowRunNode, steps: ReadonlyArray<WorkflowStep>) =>
  buildWorkflowFeed(
    buildWorkflowTimeline({
      run: node.run,
      steps,
      children: node.children.map((child) => child.run),
      nowMs: Date.parse(node.run.updatedAt),
    }),
  );
