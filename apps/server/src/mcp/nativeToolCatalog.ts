import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { DeviceStandardToolkit, DeviceScreenshotToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { HtmlRenderToolkit, HtmlPreviewToolkit } from "./toolkits/html/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewStandardToolkit, PreviewSnapshotToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

export const nativeToolCatalog = [
  ...Object.values(AttachmentToolkit.tools),
  ...Object.values(DeviceStandardToolkit.tools),
  ...Object.values(DeviceScreenshotToolkit.tools),
  ...Object.values(EnvironmentToolkit.tools),
  ...Object.values(HtmlRenderToolkit.tools),
  ...Object.values(HtmlPreviewToolkit.tools),
  ...Object.values(OrchestratorToolkit.tools),
  ...Object.values(PreviewStandardToolkit.tools),
  ...Object.values(PreviewSnapshotToolkit.tools),
  ...Object.values(PreviewControlsToolkit.tools),
  ...Object.values(ProjectToolkit.tools),
  ...Object.values(PullRequestsToolkit.tools),
  ...Object.values(ThreadToolkit.tools),
  ...Object.values(WorktreeToolkit.tools),
]
  .map((tool) => {
    const summary = (tool.description ?? "").split(/(?<=\.)\s|\n/, 1)[0] ?? "";
    return {
      name: tool.name,
      description: summary.length > 300 ? `${summary.slice(0, 299)}…` : summary,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
