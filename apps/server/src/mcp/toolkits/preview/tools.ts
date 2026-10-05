import {
  ToolActivityIcon,
  PreviewAutomationClickInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields).annotate({
  description: "The preview action completed successfully.",
});

/** Drives the real browser and can destroy page state. */
const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

/** Same open-world browser access, but the action does not destroy page state. */
const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

/** A safe browser action that only observes, so it is also repeatable. */
const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
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

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Initialize a collaborative browser tab and open its thread-bound inline preview by default. Set open=false for background-only automation. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://t3.chat'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a page before interacting. Pass tabId to inspect a specific tab; omit it to use the current tab. Returns page state, semantic elements, diagnostics, action history, and a PNG screenshot. When the desktop host supports it, viewportText describes the current view, scroll reports page and visible container scroll positions, and inViewport elements come first. visibleText also includes rendered text outside the view; content not yet loaded requires scrolling. The text is capped near 20 KB, keeps current-view text ahead of offscreen page text, and lists what it omitted. Set captureText=true to hold all loaded, rendered main-page text in temporary browser memory without a total character cap; use textCaptureId and textTabId with preview_read_text to read it in small parts. No text file is created. The capture expires after five idle minutes, a page change, or a replacement capture. This does not scroll or load missing text, and excludes embedded frames and shadow DOM. Set includeImage=false for text-only output with the same page metadata. Set save=true to also write the PNG to disk and get screenshotPath back; with includeImage=false, save=true returns only the url and saved artifact details. Embed screenshotPath in your reply as ![alt](screenshotPath) so the user sees it. This is the only way to show the user a screenshot; the image in the tool result is not saved anywhere.",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Include the PNG image in the tool response. Defaults to true. Set false for text-only output.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Write the screenshot PNG to disk and return its absolute path as screenshotPath. With includeImage=false, return only the url and saved artifact details. Defaults to false.",
        }),
      ),
      captureText: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Keep all loaded, rendered main-page text in temporary browser memory and return textCaptureId, textTabId, textChars, and textUrl. Read it with preview_read_text. No text file or total character cap; snapshot output stays bounded. Does not scroll or load missing content. Defaults to false.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Inspect browser page")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, false),
);

export const PreviewReadTextTool = safeBrowserTool(
  Tool.make("preview_read_text", {
    description:
      "Read one small part of the loaded main-page text captured by preview_snapshot with captureText=true. Pass its textCaptureId as captureId and textTabId as tabId. Start with offset=0, then use nextOffset for the next part until done=true. Each response contains at most 4096 UTF-16 characters and preserves whole character pairs. Reading refreshes the five-minute idle expiry. Set release=true to discard the capture when finished; it returns no text. A page change or replacement capture also discards it. Text is read from temporary browser memory without creating a text file; normal chat and tool history can still store the text you read.",
    parameters: Schema.Struct({
      tabId: PreviewTabId.pipe(
        Schema.annotateEncoded({
          description: "The textTabId returned by the snapshot that captured this text.",
        }),
      ),
      captureId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)).annotate({
        description: "The textCaptureId returned by preview_snapshot with captureText=true.",
      }),
      offset: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
          description: "UTF-16 character offset. Defaults to zero; use nextOffset to continue.",
        }),
      ),
      release: Schema.optional(
        Schema.Boolean.annotate({
          description: "Discard the captured text without reading another part. Defaults to false.",
        }),
      ),
    }),
    success: Schema.Struct({
      text: Schema.String.check(Schema.isMaxLength(4096)),
      nextOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      totalChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      done: Schema.Boolean,
      released: Schema.Boolean,
    }),
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Read captured browser text")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, false),
);

const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together.",
    parameters: PreviewAutomationClickInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}.",
    parameters: PreviewAutomationPressInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

/**
 * MCP `structuredContent` must be a JSON object, and Claude Code rejects the
 * whole result when it is not. Wrapping keeps arrays, strings, numbers, and
 * null valid instead of failing only for non-object expressions.
 */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
}).annotate({ description: "The evaluated expression result." });

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Returns {value} with a serializable result up to 64 KB; the expression may mutate page state.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and transfer the compressed recording once (up to 50 MiB) to an evidence file readable in this agent's environment. Returns its environment-local path after transfer succeeds.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewAutomationError,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewReadTextTool,
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
  PreviewOpenTool,
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
