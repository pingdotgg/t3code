import { pipe } from "effect/Function";
import {
  feedbackPreviewFields,
  feedbackRequestDisplay,
  feedbackRequestFailureMessage,
  type FeedbackRequestItem,
  feedbackTraceLines,
  feedbackTraceSummary,
} from "@t3tools/client-runtime/feedback-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentFeedbackPreview,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const TITLE = "Feedback for the T3 team";
const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };

export function FeedbackRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  const [open, setOpen] = useState(false);
  if (item.type !== "feedback_request") return null;
  const display = feedbackRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return <PendingFeedbackRequest environmentId={props.environmentId} item={item} />;
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LOCK_SYMBOL
      : display.outcome === "sent"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 gap-2 px-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-9 flex-row items-center gap-2"
      >
        <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
        <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
          {TITLE} · {display.label}
        </Text>
      </Pressable>
      {open ? <FeedbackPreview preview={item.preview} /> : null}
    </View>
  );
}

function PendingFeedbackRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: FeedbackRequestItem;
}) {
  const answer = useAtomCommand(serverEnvironment.answerFeedbackRequest, {
    label: "answer feedback request",
    reportFailure: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two taps can land before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (reply: "send" | "decline") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: { threadId: props.item.threadId, turnItemId: props.item.id, answer: reply },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    pipe(squashAtomCommandFailure(result), feedbackRequestFailureMessage, setError);
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">
          Send this report to the T3 team?
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
          This is everything that leaves your machine. Nothing is sent unless you tap Send.
        </Text>
      </View>
      <FeedbackPreview preview={props.item.preview} />
      {error !== null ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label="Send"
        tone="primary"
        fullWidth
        disabled={submitting}
        onPress={() => void send("send")}
      />
      <Button
        label="Don't send"
        tone="text"
        disabled={submitting}
        onPress={() => void send("decline")}
      />
    </View>
  );
}

function FeedbackPreview({ preview }: { readonly preview: AgentFeedbackPreview }) {
  const [outlineOpen, setOutlineOpen] = useState(false);
  return (
    <View className="gap-2">
      {feedbackPreviewFields(preview).map((field) => (
        <View key={field.label} className="gap-0.5">
          <Text className="font-sans text-xs text-foreground-muted">{field.label}</Text>
          <Text selectable className="font-sans text-sm text-foreground">
            {field.value}
          </Text>
        </View>
      ))}
      {preview.trace !== null ? (
        <View className="gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: outlineOpen }}
            onPress={() => setOutlineOpen((value) => !value)}
          >
            <Text className="font-sans text-xs text-foreground-muted">
              {feedbackTraceSummary(preview.trace)} · {outlineOpen ? "Hide" : "Show"}
            </Text>
          </Pressable>
          {outlineOpen
            ? feedbackTraceLines(preview.trace).map((entry) => (
                <View key={entry.key} className="gap-0.5">
                  <Text className="font-mono text-xs text-foreground-muted">{entry.line}</Text>
                  {entry.text !== undefined ? (
                    <Text selectable className="font-mono text-xs text-foreground">
                      {entry.text}
                    </Text>
                  ) : null}
                </View>
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
}
