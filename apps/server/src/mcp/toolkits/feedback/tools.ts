import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { FeedbackInput, FeedbackReport } from "../../../feedback/FeedbackReport.ts";
import * as Feedback from "../../../feedback/FeedbackService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Feedback.FeedbackService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

export const FeedbackToolkit = Toolkit.make(
  Tool.make("t3_feedback", {
    ...shared,
    description:
      "Report a T3 Code problem to the T3 team: a T3 tool or `t3` command that misbehaved, a confusing instruction, or a missing capability. Not for the user's own code. Describe T3's behavior in your own words; never quote the user's messages, code, files, or names.",
    parameters: FeedbackInput,
    success: FeedbackReport,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_feedback_list", {
    ...shared,
    description: "List this machine's recent T3 Code feedback reports.",
    success: Schema.Struct({ reports: Schema.Array(FeedbackReport) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
