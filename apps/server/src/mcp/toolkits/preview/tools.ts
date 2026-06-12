import {
  PreviewAutomationClickInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  browserTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

export const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report whether the scoped thread has an automation-capable desktop preview, including its active tab, URL, title, visibility, and loading state.",
  success: PreviewAutomationStatus,
  failure: PreviewAutomationError,
  dependencies,
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
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

export const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate the active collaborative browser tab. Pass {url:'https://t3.chat'} for a website, or {target:{kind:'environment-port',port:5173}} for a dev server in the current environment. Exactly one of url or target is required. Defaults to waiting for page loading to stop.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

export const PreviewSnapshotTool = readonlyBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect the current page before interacting. Returns URL/title/loading state, visible text, semantic interactive elements with reusable selectors and coordinates, accessibility data, recent console/network failures, action history, and a PNG screenshot.",
    success: PreviewAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

export const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one page target. Prefer locator with a Playwright selector such as role=button[name='Send']; selector accepts legacy CSS; x and y are viewport CSS pixels and must be supplied together. Call preview_snapshot first when the target is unknown.",
    parameters: PreviewAutomationClickInput,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

export const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input. Prefer locator with a Playwright role/text selector; selector accepts legacy CSS. If neither is supplied, types into the currently focused element. Set clear=true to replace existing text.",
    parameters: PreviewAutomationTypeInput,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

export const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press one keyboard key in the active page, for example {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}. This targets the page's current focus.",
    parameters: PreviewAutomationPressInput,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

export const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll by CSS pixels. Positive deltaY scrolls down and positive deltaX scrolls right. Without locator/selector it scrolls the viewport; otherwise it scrolls that container. At least one delta is required.",
    parameters: PreviewAutomationScrollInput,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

export const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate a JavaScript expression in the page's main frame and return a serializable result up to 64 KB. Prefer preview_snapshot and semantic click/type/wait tools; use this for inspection or interactions those tools cannot express. The expression may mutate page state.",
    parameters: PreviewAutomationEvaluateInput,
    success: Schema.Unknown,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

export const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait until all supplied conditions match: a Playwright locator, legacy CSS selector, visible-text substring, and/or URL substring. Provide at least one condition. Defaults to 15 seconds, maximum 60 seconds.",
    parameters: PreviewAutomationWaitForInput,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

export const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the active collaborative browser tab while keeping it interactive for both agent and human use.",
    success: PreviewAutomationRecordingStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

export const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description: "Stop the active browser recording and save it as a local evidence artifact.",
    success: PreviewAutomationRecordingArtifact,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Stop browser recording"),
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
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);
