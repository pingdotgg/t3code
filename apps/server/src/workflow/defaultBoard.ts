import type { ProviderOptionSelection } from "@t3tools/contracts";
import { WorkflowDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface DefaultBoardAgent {
  readonly instance: string;
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
}

const decodeWorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinition);

const PLAN_INSTRUCTION = `You are planning the ticket "{{ticket.title}}".

Ticket description:
{{ticket.description}}

Investigate the codebase and write a short, concrete implementation plan to a
file named .t3/ticket/{{ticket.id}}/PLAN.md at the repo root of this worktree: the goal, the files you
expect to touch, the approach, and the main risks. Do not implement anything
yet. Keep the plan under a page.`;

const SPEC_INSTRUCTION = `Turn the plan in .t3/ticket/{{ticket.id}}/PLAN.md for ticket "{{ticket.title}}" into a concrete spec.

Write .t3/ticket/{{ticket.id}}/SPEC.md at the repo root of this worktree containing: the exact behavior
to build, edge cases to handle, and a checklist of verifiable acceptance
criteria (including which tests or checks must pass). Adjust .t3/ticket/{{ticket.id}}/PLAN.md if your
investigation contradicts it. Do not implement anything yet.`;

const IMPLEMENT_INSTRUCTION = `Implement ticket "{{ticket.title}}" in this worktree according to .t3/ticket/{{ticket.id}}/SPEC.md.

If a .t3/ticket/{{ticket.id}}/REVIEW.md file exists at the repo root, a previous review requested
changes: address every issue listed there first, then delete .t3/ticket/{{ticket.id}}/REVIEW.md.

Satisfy each acceptance criterion in .t3/ticket/{{ticket.id}}/SPEC.md, run the relevant tests/checks,
and fix what you break. Keep the change focused on the ticket.`;

const REVIEW_INSTRUCTION = `Review the accumulated work for ticket "{{ticket.title}}".

Diff the worktree against {{ticket.baseRef}} and judge it against .t3/ticket/{{ticket.id}}/SPEC.md.
Look for blocking correctness, reliability, or integration issues and unmet
acceptance criteria — ignore style nits.

If changes are required, write the specific, actionable issues to .t3/ticket/{{ticket.id}}/REVIEW.md at
the repo root (overwrite it) so the next implementation pass can address them.
If the work is ready, make sure no .t3/ticket/{{ticket.id}}/REVIEW.md file remains.`;

const REVIEW_OUTPUT_HINT = `Your result object must be {"verdict": "approve"} or {"verdict": "revise"}.`;

/**
 * Default board: Backlog → Planning → Specifying → Implementation (with an
 * implement/review loop bounded by lane.runCount) → Owner Review → Land →
 * Done. Failures park in a phase-specific issues lane — Planning Issues for
 * plan/spec problems, Implementation Issues for build/land problems — and
 * Manual Review holds tickets whose review loop budget is exhausted. The
 * loop budget is the "3" in the Implementation transitions — edit it in the
 * workflow editor to allow more or fewer passes.
 */
export const defaultBoardDefinition = (input: {
  readonly name: string;
  readonly agent: DefaultBoardAgent;
}): WorkflowDefinition => {
  const agent = {
    instance: input.agent.instance,
    model: input.agent.model,
    ...(input.agent.options === undefined ? {} : { options: input.agent.options }),
  };
  return decodeWorkflowDefinition({
    name: input.name,
    settings: { maxConcurrentTickets: 3 },
    lanes: [
      {
        key: "backlog",
        name: "Backlog",
        entry: "manual",
        actions: [
          {
            label: "Start work",
            to: "planning",
            hint: "The agent plans, specs, implements and reviews the ticket.",
          },
        ],
      },
      {
        key: "planning",
        name: "Planning",
        entry: "auto",
        pipeline: [
          {
            key: "plan",
            type: "agent",
            agent,
            instruction: PLAN_INSTRUCTION,
            retry: { maxAttempts: 2 },
          },
        ],
        on: { success: "specifying", failure: "planning_issues", blocked: "planning_issues" },
      },
      {
        key: "specifying",
        name: "Specifying",
        entry: "auto",
        pipeline: [
          {
            key: "spec",
            type: "agent",
            agent,
            instruction: SPEC_INSTRUCTION,
            retry: { maxAttempts: 2 },
          },
        ],
        on: { success: "implementation", failure: "planning_issues", blocked: "planning_issues" },
      },
      {
        key: "planning_issues",
        name: "Planning Issues",
        entry: "manual",
        actions: [
          {
            label: "Retry planning",
            to: "planning",
            hint: "Run planning and specification again.",
          },
          {
            label: "Back to backlog",
            to: "backlog",
            hint: "Park the ticket; nothing runs until you start it again.",
          },
        ],
      },
      {
        key: "implementation",
        name: "Implementation",
        entry: "auto",
        pipeline: [
          {
            key: "implement",
            type: "agent",
            agent,
            instruction: IMPLEMENT_INSTRUCTION,
            retry: { maxAttempts: 2 },
          },
          {
            key: "review",
            type: "agent",
            agent,
            instruction: `${REVIEW_INSTRUCTION}\n\n${REVIEW_OUTPUT_HINT}`,
            captureOutput: true,
          },
        ],
        transitions: [
          {
            when: {
              and: [
                { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
                { "<": [{ var: "lane.runCount" }, 3] },
              ],
            },
            to: "implementation",
          },
          {
            when: { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
            to: "manual_review",
          },
          {
            when: { "==": [{ var: "steps.review.output.verdict" }, "approve"] },
            to: "owner_review",
          },
        ],
        // No transition matched means the review verdict was malformed or
        // missing — that needs eyes, not an owner-review rubber stamp.
        on: {
          success: "implementation_issues",
          failure: "implementation_issues",
          blocked: "implementation_issues",
        },
      },
      {
        key: "owner_review",
        name: "Owner Review",
        entry: "manual",
        actions: [
          {
            label: "Approve & land",
            to: "land",
            hint: "Merge the ticket's work into the branch checked out in your repo.",
          },
          {
            label: "Send back",
            to: "implementation",
            hint: "Run another implement + review pass.",
          },
        ],
      },
      {
        key: "land",
        name: "Land",
        entry: "manual",
        pipeline: [
          {
            key: "merge",
            type: "merge",
            cleanupPaths: [".t3/ticket/{{ticket.id}}"],
          },
        ],
        on: { success: "done", failure: "implementation_issues", blocked: "implementation_issues" },
      },
      {
        key: "manual_review",
        name: "Manual Review",
        entry: "manual",
        actions: [
          {
            label: "Approve & land",
            to: "land",
            hint: "Merge the ticket's work into the branch checked out in your repo.",
          },
          {
            label: "Send back",
            to: "implementation",
            hint: "Run another implement + review pass with a fresh loop budget.",
          },
        ],
      },
      {
        key: "implementation_issues",
        name: "Implementation Issues",
        entry: "manual",
        actions: [
          {
            label: "Retry implementation",
            to: "implementation",
            hint: "Run the implement + review pipeline again.",
          },
          {
            label: "Re-plan",
            to: "planning",
            hint: "Start over from planning with what you learned.",
          },
          {
            label: "Back to backlog",
            to: "backlog",
            hint: "Park the ticket; nothing runs until you start it again.",
          },
        ],
      },
      { key: "done", name: "Done", entry: "manual", terminal: true, retention: "14 days" },
    ],
  });
};
