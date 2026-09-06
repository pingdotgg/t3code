import {
  EnvironmentUsageMcpFailure,
  EnvironmentUsageMcpInput,
  EnvironmentUsageMcpResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EnvironmentUsageMcpService } from "../../EnvironmentUsageMcpService.ts";

export const EnvironmentUsageTool = Tool.make("t3_environment_usage", {
  description:
    "Read bounded, aggregated provider usage for the current T3 environment. Queries the existing usage service for at most 31 calendar days (or 24 hours at hourly resolution), returning a deterministic page of provider/model buckets, token totals, API-equivalent estimated cost provenance, safe source status counts, and pricing status. This explicit read may scan provider transcript files, refresh the existing pricing cache, and update the existing scan cache; it never returns transcript content, provider-home paths, source fingerprints, credentials, or raw errors. Pagination is over a live summary, so later pages can shift if transcripts change.",
  parameters: EnvironmentUsageMcpInput,
  success: EnvironmentUsageMcpResult,
  failure: EnvironmentUsageMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, EnvironmentUsageMcpService],
})
  .annotate(Tool.Title, "Read environment usage")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const EnvironmentUsageToolkit = Toolkit.make(EnvironmentUsageTool);
