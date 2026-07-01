import { Effect } from "effect";
import * as Schema from "effect/Schema";

export const ReviewChangesScope = Schema.Literals(["uncommitted", "against-base"]);
export type ReviewChangesScope = typeof ReviewChangesScope.Type;

export const DEFAULT_REVIEW_CHANGES_SCOPE: ReviewChangesScope = "uncommitted";

export const DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE = `Act as a code reviewer, focusing on newly introduced, discrete, actionable defects.
Prioritize correctness, performance, security, reliability, and maintainability.
Avoid speculative, stylistic, or low-signal feedback.
Verify concerns using surrounding code and tests where useful.
Report findings concisely in normal Markdown.
State briefly if no actionable issues are found.
Follow repository rules, including using bun run test rather than bun test; code changes would additionally require bun fmt, bun lint, and bun typecheck.
Use the code-review skill's systematic review workflow.`;

export const ReviewChangesWorkflowSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  defaultScope: ReviewChangesScope.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_CHANGES_SCOPE)),
  ),
  promptTemplate: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE)),
  ),
});
export type ReviewChangesWorkflowSettings = typeof ReviewChangesWorkflowSettings.Type;

export const AgentWorkflowSettings = Schema.Struct({
  reviewChanges: ReviewChangesWorkflowSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type AgentWorkflowSettings = typeof AgentWorkflowSettings.Type;
