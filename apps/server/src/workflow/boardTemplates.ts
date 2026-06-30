import type { AgentSelection, BoardTemplateSummary, WorkflowDefinition } from "@t3tools/contracts";
import { WorkflowDefinition as WorkflowDefinitionSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { defaultBoardDefinition } from "./defaultBoard.ts";

const decodeWorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinitionSchema);

const IMPLEMENT_INSTRUCTION = `Implement ticket "{{ticket.title}}" in this worktree.

Ticket {{ticket.id}} description:
{{ticket.description}}

If a .t3/ticket/{{ticket.id}}/REVIEW.md file exists at the repo root, a previous
review requested changes: address every issue listed there first, then delete
.t3/ticket/{{ticket.id}}/REVIEW.md. Run the relevant tests/checks and fix what you
break. Keep the change focused on the ticket.`;

const REVIEW_INSTRUCTION = `Review the accumulated work for ticket "{{ticket.title}}".

Diff the worktree against {{ticket.baseRef}} and judge whether it correctly
implements the ticket. Look for blocking correctness, reliability, or
integration issues — ignore style nits.

If changes are required, write the specific, actionable issues to
.t3/ticket/{{ticket.id}}/REVIEW.md at the repo root (overwrite it) so the next
implementation pass can address them. If the work is ready, make sure no
.t3/ticket/{{ticket.id}}/REVIEW.md file remains.`;

const REVIEW_OUTPUT_HINT = `Your result object must be {"verdict": "approve"} or {"verdict": "revise"}.`;

const DESIGN_DIR = ".t3/ticket/{{ticket.id}}/design";

const BRAINSTORM_INSTRUCTION = `You are brainstorming the design for ticket "{{ticket.title}}".

Seed idea (ticket {{ticket.id}} description):
{{ticket.description}}

Work like a thoughtful collaborator: ask the user ONE clarifying question at a
time and wait for their answer before asking the next. Cover purpose,
constraints, success criteria, and 2-3 approaches with a recommendation.

When you understand what to build, write the design spec as Markdown to
${DESIGN_DIR}/SPEC.md (create the directory if needed) and stop. The spec is the
only artifact that matters — make it complete and self-contained.`;

const SPEC_REVIEW_INSTRUCTION = `Adversarially review the design spec at
${DESIGN_DIR}/SPEC.md for ticket "{{ticket.title}}".

Look for missing requirements, contradictions, unjustified scope, and anything
that would break if built as written. Write your critique to
${DESIGN_DIR}/SPEC-REVIEW.md (overwrite it). If the spec is sound, say so there.`;

const PLAN_INSTRUCTION = `Write an implementation plan for ticket "{{ticket.title}}".

Read the approved design spec at ${DESIGN_DIR}/SPEC.md. Produce a concrete,
bite-sized, test-driven implementation plan and write it as Markdown to
${DESIGN_DIR}/PLAN.md (overwrite it). Exact file paths, real code, real test
commands — assume the implementer has no prior context.`;

const PLAN_REVIEW_INSTRUCTION = `Adversarially review the implementation plan at
${DESIGN_DIR}/PLAN.md against the spec at ${DESIGN_DIR}/SPEC.md for ticket
"{{ticket.title}}".

Check spec coverage, placeholder/hand-wavy steps, and type/name consistency.
Write your critique to ${DESIGN_DIR}/PLAN-REVIEW.md (overwrite it).`;

const BUILD_INSTRUCTION = `Implement the plan for ticket "{{ticket.title}}" in this worktree.

Follow ${DESIGN_DIR}/PLAN.md (which implements ${DESIGN_DIR}/SPEC.md). If a
${DESIGN_DIR}/BUILD-REVIEW.md file exists, a previous review requested changes:
address every issue there first, then delete ${DESIGN_DIR}/BUILD-REVIEW.md. Run
the relevant tests/checks and fix what you break. Keep the change focused.`;

const BUILD_REVIEW_INSTRUCTION = `Review the accumulated work for ticket "{{ticket.title}}".

Diff the worktree against {{ticket.baseRef}} and judge whether it correctly
implements ${DESIGN_DIR}/PLAN.md. Look for blocking correctness, reliability, or
integration issues — ignore style nits. If changes are required, write specific,
actionable issues to ${DESIGN_DIR}/BUILD-REVIEW.md (overwrite it) so the next
build pass can address them. If the work is ready, ensure no
${DESIGN_DIR}/BUILD-REVIEW.md remains.`;

/**
 * Lite agent loop: To do → In progress (implement → review, looping back on a
 * "revise" verdict while the lane.runCount budget lasts, then parking in Needs
 * attention) → Done. A minimal agent-driven board for small tickets that do not
 * need the full plan/spec scaffolding of the default SDLC board.
 */
const liteAgentLoopDefinition = (input: {
  readonly name: string;
  readonly agent: AgentSelection;
}): WorkflowDefinition => {
  const agent = {
    instance: input.agent.instance,
    model: input.agent.model,
    ...(input.agent.options === undefined ? {} : { options: input.agent.options }),
  };
  return decodeWorkflowDefinition({
    name: input.name,
    lanes: [
      {
        key: "to-do",
        name: "To do",
        entry: "manual",
        actions: [
          {
            label: "Start work",
            to: "in-progress",
            hint: "The agent implements and reviews the ticket.",
          },
        ],
      },
      {
        key: "in-progress",
        name: "In progress",
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
            to: "in-progress",
          },
          {
            when: { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
            to: "needs-attention",
          },
          {
            when: { "==": [{ var: "steps.review.output.verdict" }, "approve"] },
            to: "done",
          },
        ],
        // No transition matched means the review verdict was malformed or
        // missing — that needs eyes.
        on: { success: "needs-attention", failure: "needs-attention", blocked: "needs-attention" },
      },
      {
        key: "needs-attention",
        name: "Needs attention",
        entry: "manual",
        actions: [
          {
            label: "Retry",
            to: "in-progress",
            hint: "Run another implement + review pass.",
          },
          {
            label: "Back to to-do",
            to: "to-do",
            hint: "Park the ticket.",
          },
        ],
      },
      { key: "done", name: "Done", entry: "manual", terminal: true, retention: "14 days" },
    ],
  });
};

/**
 * Design board: Idea → Brainstorm → spec gate → Plan → plan gate → Build → Done,
 * encoding the brainstorm → review → plan → review → build → review loop using
 * only existing engine primitives. Artifacts flow through files in the per-ticket
 * worktree (`.t3/ticket/<id>/design/SPEC.md` → `PLAN.md` → diff). AI review steps
 * are spliced into the producer pipelines only when `withAiReview` is set.
 */
const designBoardDefinition = (input: {
  readonly name: string;
  readonly agent: AgentSelection;
  readonly withAiReview: boolean;
}): WorkflowDefinition => {
  const agent = {
    instance: input.agent.instance,
    model: input.agent.model,
    ...(input.agent.options === undefined ? {} : { options: input.agent.options }),
  };
  const reviewStep = (key: string, instruction: string) => ({
    key,
    type: "agent",
    agent,
    instruction: `${instruction}\n\n${REVIEW_OUTPUT_HINT}`,
    captureOutput: true,
  });
  const producer = (key: string, instruction: string) => ({
    key,
    type: "agent",
    agent,
    instruction,
    retry: { maxAttempts: 2 },
  });
  return decodeWorkflowDefinition({
    name: input.name,
    lanes: [
      {
        key: "idea",
        name: "Idea",
        entry: "manual",
        actions: [
          {
            label: "Start brainstorm",
            to: "brainstorm",
            hint: "The agent asks clarifying questions, then writes the spec.",
          },
        ],
      },
      {
        key: "brainstorm",
        name: "Brainstorm",
        entry: "auto",
        pipeline: [
          producer("brainstorm", BRAINSTORM_INSTRUCTION),
          ...(input.withAiReview ? [reviewStep("spec-review", SPEC_REVIEW_INSTRUCTION)] : []),
        ],
        on: { success: "spec-gate", failure: "needs-attention", blocked: "needs-attention" },
      },
      {
        key: "spec-gate",
        name: "Spec review",
        entry: "manual",
        actions: [
          { label: "Approve spec", to: "plan", hint: "Read SPEC.md, then continue to planning." },
          { label: "Request changes", to: "brainstorm", hint: "Send it back for another pass." },
        ],
      },
      {
        key: "plan",
        name: "Plan",
        entry: "auto",
        pipeline: [
          producer("plan", PLAN_INSTRUCTION),
          ...(input.withAiReview ? [reviewStep("plan-review", PLAN_REVIEW_INSTRUCTION)] : []),
        ],
        on: { success: "plan-gate", failure: "needs-attention", blocked: "needs-attention" },
      },
      {
        key: "plan-gate",
        name: "Plan review",
        entry: "manual",
        actions: [
          { label: "Approve plan", to: "build", hint: "Read PLAN.md, then build." },
          { label: "Request changes", to: "plan", hint: "Send it back for another pass." },
        ],
      },
      {
        key: "build",
        name: "Build",
        entry: "auto",
        pipeline: [
          producer("build", BUILD_INSTRUCTION),
          ...(input.withAiReview ? [reviewStep("build-review", BUILD_REVIEW_INSTRUCTION)] : []),
        ],
        ...(input.withAiReview
          ? {
              transitions: [
                {
                  when: {
                    and: [
                      { "==": [{ var: "steps.build-review.output.verdict" }, "revise"] },
                      { "<": [{ var: "lane.runCount" }, 3] },
                    ],
                  },
                  to: "build",
                },
                {
                  when: { "==": [{ var: "steps.build-review.output.verdict" }, "revise"] },
                  to: "needs-attention",
                },
                {
                  when: { "==": [{ var: "steps.build-review.output.verdict" }, "approve"] },
                  to: "done",
                },
              ],
              on: {
                success: "needs-attention",
                failure: "needs-attention",
                blocked: "needs-attention",
              },
            }
          : { on: { success: "done", failure: "needs-attention", blocked: "needs-attention" } }),
      },
      {
        key: "needs-attention",
        name: "Needs attention",
        entry: "manual",
        actions: [
          { label: "Retry", to: "build", hint: "Run another build + review pass." },
          { label: "Back to idea", to: "idea", hint: "Park the ticket." },
        ],
      },
      { key: "done", name: "Done", entry: "manual", terminal: true, retention: "14 days" },
    ],
  });
};

/**
 * The wizard's board templates. Each entry builds a concrete
 * {@link WorkflowDefinition} from a name + agent selection. `full-sdlc` is the
 * existing default board; `lite-agent-loop` is a minimal implement→review loop.
 */
export const BOARD_TEMPLATES = [
  {
    id: "full-sdlc",
    name: "Full SDLC",
    description: "Plan → spec → implement → review pipeline with a revision loop.",
    requiresAgent: true,
    build: (input: { readonly name: string; readonly agent: AgentSelection }): WorkflowDefinition =>
      defaultBoardDefinition(input),
  },
  {
    id: "lite-agent-loop",
    name: "Lite agent loop",
    description: "To do → In progress (implement→review, loops on changes) → Done.",
    requiresAgent: true,
    build: (input: { readonly name: string; readonly agent: AgentSelection }): WorkflowDefinition =>
      liteAgentLoopDefinition(input),
  },
  {
    id: "design-board",
    name: "Design board",
    description: "Idea → brainstorm → plan → build, with human approval gates.",
    requiresAgent: true,
    build: (input: { readonly name: string; readonly agent: AgentSelection }): WorkflowDefinition =>
      designBoardDefinition({ ...input, withAiReview: false }),
  },
  {
    id: "design-board-full",
    name: "Design board (with AI review)",
    description: "Adds AI spec/plan/build reviews before each gate. Needs a capable agent.",
    requiresAgent: true,
    build: (input: { readonly name: string; readonly agent: AgentSelection }): WorkflowDefinition =>
      designBoardDefinition({ ...input, withAiReview: true }),
  },
] as const;

/** Pure summary projection of {@link BOARD_TEMPLATES} for the listBoardTemplates RPC. */
export const listBoardTemplateSummaries = (): ReadonlyArray<BoardTemplateSummary> =>
  BOARD_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    requiresAgent: template.requiresAgent,
  }));
