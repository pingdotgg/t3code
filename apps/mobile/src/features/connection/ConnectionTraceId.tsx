import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

/** Inline trace control; disclosure rows reserve ordinary taps for their own navigation. */
export function ConnectionTraceId({
  traceId,
  tone = "muted",
  activation = "press",
}: {
  readonly traceId: string;
  readonly tone?: "muted" | "danger";
  readonly activation?: "press" | "longPress";
}) {
  const copy = () => copyTextWithHaptic(traceId, { target: "connection-trace-id" });
  return (
    <>
      {" Trace ID: "}
      <Text
        accessibilityHint={
          activation === "longPress" ? "Long press to copy the trace ID" : "Copies the trace ID"
        }
        accessibilityLabel={`Copy trace ID ${traceId}`}
        accessibilityRole="button"
        accessibilityActions={[{ name: "activate", label: "Copy trace ID" }]}
        onAccessibilityAction={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.actionName === "activate") copy();
        }}
        className={cn(
          "underline decoration-dotted",
          tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
        )}
        onLongPress={
          activation === "longPress"
            ? (event) => {
                event.stopPropagation();
                copy();
              }
            : undefined
        }
        onPress={(event) => {
          event.stopPropagation();
          if (activation === "press") copy();
        }}
      >
        {traceId}
      </Text>
    </>
  );
}
