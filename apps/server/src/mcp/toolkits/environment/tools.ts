import {
  EnvironmentMcpFailure,
  EnvironmentMcpReadInput,
  EnvironmentMcpReadResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EnvironmentMcpService } from "../../EnvironmentMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, EnvironmentMcpService];

export const EnvironmentReadTool = Tool.make("t3_environment_read", {
  description:
    "Read the current authenticated T3 environment identity, platform, server version, safe feature capabilities, bounded provider availability/auth summaries, and the explicit server-owned preference allowlist. This never refreshes providers and never returns credentials, provider configuration, filesystem paths, raw diagnostics, model inventories, client-local preferences, or admin settings. Use providerCursor/providerLimit to page configured provider instances.",
  parameters: EnvironmentMcpReadInput,
  success: EnvironmentMcpReadResult,
  failure: EnvironmentMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read current T3 environment")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool);
