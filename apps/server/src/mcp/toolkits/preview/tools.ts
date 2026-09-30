import {
  PreviewAutomationActionResult,
  PreviewAutomationClickInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationEvaluateResult,
  PreviewAutomationListTabsInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenAndSnapshotInput,
  PreviewAutomationOpenAndSnapshotResult,
  PreviewAutomationOpenInput,
  PreviewAutomationPreflightInput,
  PreviewAutomationPreflightResult,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTabsResult,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
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
    "Report whether a collaborative browser tab is automation-capable, including its URL, title, visibility, loading state, viewport mode, and measured CSS-pixel size. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab.",
  parameters: PreviewAutomationTabTargetInput,
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
      "Initialize a collaborative browser tab. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab. Set open=false (or deprecated show=false) for background-only automation without surfacing the browser panel.",
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
      "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://t3.chat'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

export const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
    parameters: PreviewAutomationResizeInput,
    success: PreviewAutomationResizeResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: PreviewAutomationSetColorSchemeResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

export const PreviewTabsTool = readonlyBrowserTool(
  Tool.make("preview_tabs", {
    description:
      "List collaborative browser tabs for the current thread, including active/loading/visible state. Use tabId on other preview tools to target one.",
    parameters: PreviewAutomationListTabsInput,
    success: PreviewAutomationTabsResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "List browser tabs"),
);

export const PreviewSnapshotTool = readonlyBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a page before interacting. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab. Returns page state, semantic elements, diagnostics summary, action history, and a PNG screenshot. Budgets default to context-safe sizes; set includeAccessibilityTree=true only when needed. Pass save=true to persist the screenshot as server-side evidence and receive its screenshotPath.",
    parameters: PreviewAutomationSnapshotInput,
    success: PreviewAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

export const PreviewOpenAndSnapshotTool = safeBrowserTool(
  Tool.make("preview_open_and_snapshot", {
    description:
      "Open or reuse a collaborative browser tab, optionally navigate (url or environment-port target), wait for readiness, and return a snapshot (including tabId) in one step. Prefer this over separate open+navigate+snapshot when starting work on a page. The returned tabId becomes the agent session's current tab for later untargeted preview tools.",
    parameters: PreviewAutomationOpenAndSnapshotInput,
    success: PreviewAutomationOpenAndSnapshotResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Open browser and snapshot"),
);

export const PreviewPreflightTool = safeBrowserTool(
  Tool.make("preview_preflight", {
    description:
      "Perform one deterministic browser pairing preflight. It reports browser support/visibility/tab attachment, validates this MCP session, and optionally probes a target's token-free T3 environment descriptor plus app route. Pairing URLs are never opened, and token-bearing URLs are not returned in diagnostics. Use this before preview_open_and_snapshot or preview_navigate.",
    parameters: PreviewAutomationPreflightInput,
    success: PreviewAutomationPreflightResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Preflight preview pairing"),
);

export const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together.",
    parameters: PreviewAutomationClickInput,
    success: PreviewAutomationActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

export const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewAutomationActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

export const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}.",
    parameters: PreviewAutomationPressInput,
    success: PreviewAutomationActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

export const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewAutomationActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

export const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Returns { value } with the serializable result up to 64 KB; the expression may mutate page state.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewAutomationEvaluateResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

export const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewAutomationActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

export const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationRecordingStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

export const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop the active browser recording. The finished recording is transferred to the server and the returned path is readable in the agent environment (transferred=true); older hosts fall back to the browser host's local path.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationRecordingArtifact,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewTabsTool,
  PreviewOpenTool,
  PreviewOpenAndSnapshotTool,
  PreviewPreflightTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
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

export const PreviewStandardToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewTabsTool,
  PreviewOpenTool,
  PreviewPreflightTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool, PreviewOpenAndSnapshotTool);
