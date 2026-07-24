import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as MonitorRegistry from "../../../monitor/MonitorRegistry.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../../../sourceControl/GitHubCli.ts";

export class MonitorStartError extends Schema.TaggedErrorClass<MonitorStartError>()(
  "MonitorStartError",
  { message: Schema.String },
) {}

export const MonitorStartTool = Tool.make("monitor_start", {
  description:
    "Start monitoring a pull request for this thread. Call this after creating or identifying the PR when the user has asked you to monitor, babysit, or watch it for review feedback and CI results. The server will watch the PR and wake this thread when there is something to address. Never create the PR as a draft — review bots do not run on drafts.",
  parameters: Schema.Struct({ prNumber: Schema.Int.check(Schema.isGreaterThan(0)) }),
  success: Schema.Struct({
    prNumber: Schema.Number,
    status: Schema.Literal("monitoring"),
    warning: Schema.NullOr(Schema.String),
    message: Schema.String,
  }),
  failure: MonitorStartError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    MonitorRegistry.MonitorRegistry,
    OrchestrationEngineService,
    ProjectionSnapshotQuery,
    GitHubCli.GitHubCli,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Start PR monitoring")
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const MonitorToolkit = Toolkit.make(MonitorStartTool);
