import {
  BrowserNavigationTarget,
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationActInput,
  PreviewAutomationDialogInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields);

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Preview tab state, `tabs`, and `profiles`. Read any tab; act only on yours or an unclaimed tab.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// `url` already covers websites, so open only adds the dev-server target.
const EnvironmentPortTarget = BrowserNavigationTarget.members[1];

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Open a preview tab. Dev server: `target` not `url`. `open:false` keeps it hidden.",
    parameters: PreviewAutomationOpenInput.mapFields(
      (fields) => ({ ...fields, target: Schema.optional(EnvironmentPortTarget) }),
      { unsafePreserveChecks: true },
    ),
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss the dialog `preview_status` reports. Pass `promptText` to accept a prompt. Needs your own tab, or an unclaimed one. Desktop hosts may not support this.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description: "Navigate the tab by `url` or dev-server `target`.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize the chosen tab: {mode:'fill'}, {mode:'freeform',width,height}, or {mode:'preset',preset,orientation}. Changes CSS size only, not the user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Set `prefers-color-scheme` for the chosen tab: 'dark', 'light', or 'system' to clear the override.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Browser snapshot when asked. Page state + optional screenshot (`save=true` → `screenshotPath`). Target `aria-ref` from prior snapshot; refs reset on navigation.",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description: "Default false. True only to see the page.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description: "Write PNG, return `screenshotPath`.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewActTool = browserTool(
  Tool.make("preview_act", {
    description:
      "Act on the tab: click, type, hover, select, drag, upload, press, scroll. Target with `locator` from `preview_snapshot`.",
    parameters: PreviewAutomationActInput,
    success: Schema.Union([
      Schema.Struct({ ...PreviewAutomationSelectResult.fields, ...presentationFields }),
      PreviewActionResult,
    ]),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Act in preview page"),
);

/** Wrap non-objects: MCP requires object structuredContent, and Claude Code rejects invalid results entirely. */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
});

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Run JS in the page on your or an unclaimed tab. Returns `{value}` (max 64 KB). User-driven tabs: use `preview_snapshot` to read.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait until all given locator, selector, text, and URL conditions match in the chosen tab.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording the chosen tab.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the chosen tab. Returns a local path to the recording file (max 50 MiB).",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewActTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewActTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
