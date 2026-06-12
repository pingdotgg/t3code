import * as Effect from "effect/Effect";
import type {
  PreviewAutomationOperation,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewToolkit } from "./tools.ts";

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({
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
