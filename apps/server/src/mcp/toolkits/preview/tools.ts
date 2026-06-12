import {
  PreviewAutomationClickInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { McpInvocationContext } from "../../Services/McpInvocationContext.ts";

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, true) as T;

export const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report whether the scoped thread has an automation-capable desktop preview, including its active tab, URL, title, visibility, and loading state.",
  success: PreviewAutomationStatus,
  failure: PreviewAutomationError,
  dependencies: [McpInvocationContext],
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Show and initialize the browser preview for the scoped thread, optionally reusing its current tab and navigating to a URL.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Open browser preview"),
);

export const PreviewNavigateTool = browserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate the scoped thread's active preview tab to a URL and wait for the requested readiness condition.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Navigate browser preview"),
);

export const PreviewSnapshotTool = Tool.make("preview_snapshot", {
  description:
    "Capture bounded page metadata, visible text, interactive elements, accessibility data, and a PNG screenshot from the scoped preview tab.",
  success: PreviewAutomationSnapshot,
  failure: PreviewAutomationError,
  dependencies: [McpInvocationContext],
})
  .annotate(Tool.Title, "Capture preview snapshot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click an element selected by CSS selector or click viewport coordinates in the scoped preview tab.",
    parameters: PreviewAutomationClickInput,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Click preview page"),
);

export const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Type text into the focused element or a CSS-selected element, optionally clearing its existing value first.",
    parameters: PreviewAutomationTypeInput,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Type into preview page"),
);

export const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description: "Dispatch a keyboard key with optional modifiers to the scoped preview tab.",
    parameters: PreviewAutomationPressInput,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Press key in preview page"),
);

export const PreviewScrollTool = browserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the preview viewport or a CSS-selected scroll container by the requested deltas.",
    parameters: PreviewAutomationScrollInput,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Scroll preview page"),
);

export const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate bounded JavaScript in the scoped preview tab and return a serializable result of at most 64 KB.",
    parameters: PreviewAutomationEvaluateInput,
    success: Schema.Unknown,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

export const PreviewWaitForTool = browserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait until a CSS selector, visible-text substring, or URL substring appears in the scoped preview tab.",
    parameters: PreviewAutomationWaitForInput,
    failure: PreviewAutomationError,
    dependencies: [McpInvocationContext],
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
);
