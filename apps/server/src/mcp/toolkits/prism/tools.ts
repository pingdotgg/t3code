import { PrismLane, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export class PrismToolError extends Schema.TaggedError<PrismToolError>()("PrismToolError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const RequestId = TrimmedNonEmptyString.annotate({
  description: "The Prism job's request id, as prism_submit returned it.",
});

export const PrismSubmitInput = Schema.Struct({
  task: TrimmedNonEmptyString.annotate({
    description:
      "The whole task packet: outcome, Issue, acceptance criteria, non-goals, proof, and delivery (branch, one PR, no merge).",
  }),
  workspace: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Absolute path of the checkout the job works in. Defaults to this thread's worktree, else its project root.",
    }),
  ),
  lane: Schema.optional(
    PrismLane.annotate({
      description:
        "How difficult the job is: easy for mechanical work, hard for difficult work, medium (default) otherwise. Selects each role's model list for that lane.",
    }),
  ),
  requestId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "A unique job id. Generated when omitted.",
    }),
  ),
  handoffSummary: Schema.optional(TrimmedNonEmptyString),
});

/** The router's own JSON reply, passed through. */
export const PrismResult = Schema.Struct({
  requestId: Schema.String,
  router: Schema.Unknown,
});

const PrismSubmitTool = Tool.make("prism_submit", {
  description:
    "Hand a full job to Prism (Model Router). Prism starts a dispatcher as a child of this thread, which runs workers, falls back to another model when capacity fails, recovers stalled work, and ends with one pushed branch and one open PR carrying proof and review. This thread becomes the job's planner automatically: it is woken only when the dispatcher needs judgment, and receives the final state (ready with the PR URL, or blocked, failed or cancelled with the reason). Use it for authorized work that should end in a PR; for small direct work (a quick review, a bounded fix) use spawn_thread with a role instead.",
  parameters: PrismSubmitInput,
  success: PrismResult,
  failure: PrismToolError,
  dependencies,
})
  .annotate(Tool.Title, "Submit Prism job")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const PrismStatusTool = Tool.make("prism_status", {
  description:
    "Read a Prism job's state: status, route, launches, open questions and recent events. Use it when the user asks how a job is going; the final state arrives in this thread by itself.",
  parameters: Schema.Struct({ requestId: RequestId }),
  success: PrismResult,
  failure: PrismToolError,
  dependencies,
})
  .annotate(Tool.Title, "Prism job status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PrismQuestionsTool = Tool.make("prism_questions", {
  description:
    "List a Prism job's questions for its planner: pending ones by default, all with includeAnswered. Answer each with prism_answer.",
  parameters: Schema.Struct({
    requestId: RequestId,
    includeAnswered: Schema.optional(Schema.Boolean),
  }),
  success: PrismResult,
  failure: PrismToolError,
  dependencies,
})
  .annotate(Tool.Title, "Prism job questions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PrismAnswerTool = Tool.make("prism_answer", {
  description:
    "Answer one of a Prism job's pending questions; the dispatcher continues with the answer. Decide within your authority; take Human Gates to the user first.",
  parameters: Schema.Struct({
    requestId: RequestId,
    qid: TrimmedNonEmptyString.annotate({ description: "The question id from prism_questions." }),
    answer: TrimmedNonEmptyString,
  }),
  success: PrismResult,
  failure: PrismToolError,
  dependencies,
})
  .annotate(Tool.Title, "Answer Prism question")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const PrismToolkit = Toolkit.make(
  PrismSubmitTool,
  PrismStatusTool,
  PrismQuestionsTool,
  PrismAnswerTool,
);
