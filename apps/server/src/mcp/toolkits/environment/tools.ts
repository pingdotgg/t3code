import {
  EnvironmentMcpFailure,
  EnvironmentMcpPreferencesUpdateInput,
  EnvironmentMcpPreferencesUpdateResult,
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

export const EnvironmentPreferencesUpdateTool = Tool.make("t3_environment_preferences_update", {
  description:
    "Update only the explicit server-owned preference fields in this input, then return the actual normalized preference allowlist after persistence. Omitted fields are unchanged; an explicit empty source-control customInstructions string clears it. This environment-wide mutation requires the calling thread to remain in full-access runtime mode and default interaction mode through persistence. It cannot change provider configuration, credentials, paths, observability, browser access, themes, pairing, tunnels, admin controls, client-local settings, or arbitrary server settings.",
  parameters: EnvironmentMcpPreferencesUpdateInput,
  success: EnvironmentMcpPreferencesUpdateResult,
  failure: EnvironmentMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update T3 environment preferences")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesUpdateTool,
);
