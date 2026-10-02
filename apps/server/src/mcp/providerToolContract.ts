import { createHash } from "node:crypto";

import { Tool } from "effect/unstable/ai";

import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { PullRequestMonitorToolkit } from "./toolkits/pullRequestMonitor/tools.ts";
import { CollaborativeAcceptanceToolkit } from "./toolkits/collaborativeAcceptance/tools.ts";
import { DelegationToolkit } from "./toolkits/delegation/tools.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";

export const providerMcpTools = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(PullRequestMonitorToolkit.tools),
  ...Object.values(CollaborativeAcceptanceToolkit.tools),
  ...Object.values(TerminalToolkit.tools),
  ...Object.values(DelegationToolkit.tools),
].sort((left, right) => left.name.localeCompare(right.name));

export const fingerprintProviderMcpToolContract = (): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        providerMcpTools.map((tool) => ({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
        })),
      ),
    )
    .digest("hex");
