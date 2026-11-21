import { useGT } from "gt-react-native";
import { defineNativePluginFeature } from "../../plugins/features";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

function BuiltinConnectionTraceId({
  traceId,
  tone = "muted",
  activation = "press",
}: {
  readonly traceId: string;
  readonly tone?: "muted" | "danger";
  readonly activation?: "press" | "longPress";
}) {
  const gt = useGT();
  const copy = () => copyTextWithHaptic(traceId, { target: "connection-trace-id" });
  return (
    <>
      {" "}
      {gt("Trace ID:")}{" "}
      <Text
        accessibilityHint={
          activation === "longPress"
            ? gt("Long press to copy the trace ID")
            : gt("Copies the trace ID")
        }
        accessibilityLabel={gt("Copy trace ID {traceId}", { traceId })}
        accessibilityRole="button"
        accessibilityActions={[{ name: "activate", label: gt("Copy trace ID") }]}
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

export const ConnectionTraceId = defineNativePluginFeature(
  "native.features.connection.connection-trace-id",
  BuiltinConnectionTraceId,
);
