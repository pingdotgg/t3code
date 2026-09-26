import { toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";

/**
 * The "Copy trace ID" action on connection error toasts. Reports both outcomes —
 * a silent failure reads as a dead control — and stays on the shared write path
 * so plain-HTTP clients keep the execCommand fallback.
 */
export function copyErrorTraceId(traceId: string): void {
  void writeTextToClipboard(traceId, "trace ID").then(
    (didCopy) => {
      if (!didCopy) return;
      toastManager.add({ type: "success", title: "Trace ID copied", description: traceId });
    },
    (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy trace ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  );
}
