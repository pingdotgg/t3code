import * as Effect from "effect/Effect";
import type {
  PreviewAutomationOperation,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
} from "@t3tools/contracts";

import { requireMcpCapability } from "../../Services/McpInvocationContext.ts";
import { previewAutomationBroker } from "../../Layers/PreviewAutomationBroker.ts";
import { PreviewToolkit } from "./tools.ts";

const invoke = <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
): Effect.Effect<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  import("../../Services/McpInvocationContext.ts").McpInvocationContext
> =>
  Effect.gen(function* () {
    const scope = yield* requireMcpCapability("preview");
    return yield* previewAutomationBroker.invoke<A>({
      scope,
      operation,
      input,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  });

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer({
  preview_status: () => invoke<PreviewAutomationStatus>("status", {}),
  preview_open: (input) =>
    invoke<PreviewAutomationStatus>("open", {
      ...input,
      show: input.show ?? true,
      reuseExistingTab: input.reuseExistingTab ?? true,
    }),
  preview_navigate: (input) => invoke<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_snapshot: () => invoke<PreviewAutomationSnapshot>("snapshot", {}),
  preview_click: (input) => invoke<void>("click", input, input.timeoutMs),
  preview_type: (input) => invoke<void>("type", input, input.timeoutMs),
  preview_press: (input) => invoke<void>("press", input),
  preview_scroll: (input) => invoke<void>("scroll", input),
  preview_evaluate: (input) => invoke<unknown>("evaluate", input),
  preview_wait_for: (input) => invoke<void>("waitFor", input, input.timeoutMs),
  preview_recording_start: () => invoke<PreviewAutomationRecordingStatus>("recordingStart", {}),
  preview_recording_stop: () => invoke<PreviewAutomationRecordingArtifact>("recordingStop", {}),
});
