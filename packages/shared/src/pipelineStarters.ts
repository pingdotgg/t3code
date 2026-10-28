import {
  PipelineStepId,
  ProviderInstanceId,
  type ModelSelection,
  type PipelineStep,
} from "@t3tools/contracts";

/** A pipeline shipped with T3 Code. Servers seed each one once; editors offer them as templates. */
export interface PipelineStarter {
  /** Stable forever: seeding records it so a deleted starter never comes back on its own. */
  readonly key: string;
  readonly name: string;
  /** One line shown next to the name when offering the starter as a template. */
  readonly description: string;
  readonly steps: ReadonlyArray<PipelineStep>;
}

const claude = (model: string, effort: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model,
  options: [{ id: "effort", value: effort }],
});

const GIT_AND_TRACKING = `Git and tracking:
- Work on a feature branch, never the default branch. Create one if needed.
- Commit each logical change with a clear message and push it.
- Keep exactly one pull request for this work: open it as a draft if none exists, otherwise update it and keep its description current.
- If the work belongs to a ticket (Linear, GitHub issue, …) and you have tools for it, update its status at real milestones only.
- No status spam: no comments that only say you started or are still working.
- If you lack access for any of this, skip it and say so at the end.`;

const step = (
  input: Omit<PipelineStep, "id" | "skills" | "pauseBefore"> & {
    readonly id: string;
    readonly pauseBefore?: boolean;
  },
): PipelineStep => ({
  ...input,
  id: PipelineStepId.make(input.id),
  skills: [],
  pauseBefore: input.pauseBefore ?? false,
});

export const FEATURE_DELIVERY_PIPELINE: PipelineStarter = {
  key: "feature-delivery",
  name: "Feature delivery",
  description: "Refine → Implement → QA → Review → Guide",
  steps: [
    step({
      id: "requirements",
      name: "Refine requirements",
      modelSelection: claude("claude-opus-5-5", "medium"),
      runtimeMode: "full-access",
      promptTemplate: `You are the first step of a delivery pipeline. Later steps (implementation, QA, review) only see what you write, so make the requirements unambiguous.

Request:
{{input}}

1. Read the relevant code, docs and repo instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING) to understand the context.
2. Find gaps, ambiguities and conflicting assumptions. If only I can decide something, ask with your question tool and wait for my answer. Never end your turn with open questions. Decide reasonable defaults yourself and state them.
3. Do not change any files.

Finish with the refined requirements: goal, scope and non-goals, user-visible behaviour, acceptance criteria as a checklist, affected areas and surfaces, risks, and the decisions made (including my answers).`,
    }),
    step({
      id: "implement",
      name: "Implement",
      modelSelection: claude("claude-sonnet-5-5", "medium"),
      runtimeMode: "full-access",
      pauseBefore: true,
      promptTemplate: `Implement these requirements:

{{steps.requirements.output}}

Original request, for context:
{{input}}

- Follow the repo's own instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING) and match the surrounding code.
- Add or update focused tests for behaviour that can break. Run the repo's format, lint, typecheck and relevant tests before you finish.

${GIT_AND_TRACKING}

Finish with: what you built, the areas you changed, how to run and try it, test results, the branch and PR link, and anything left open.`,
    }),
    step({
      id: "qa-prep",
      name: "Prepare QA",
      modelSelection: claude("claude-sonnet-5-5", "medium"),
      runtimeMode: "full-access",
      promptTemplate: `Prepare a hands-on QA run for this change.

Requirements:
{{steps.requirements.output}}

Implementation summary:
{{steps.implement.output}}

1. Read the branch's diff against its base. List every changed screen, route, dialog, command, API and setting, plus everything that reuses changed code.
2. Get the app running for a real test the way the repo documents it, isolated from production and personal data. Start long-running processes detached so they survive the end of your turn. Record their PIDs, ports, URLs and how to log in or pair.
3. Write a full QA plan: one numbered task per check, grouped by area. Each task says where to go (exact URL, route or screen), the steps, the expected result and what to screenshot. Cover the happy path, edge cases, errors, empty and loading states, reverse paths (undo, close, cancel), permissions, narrow and mobile widths, light and dark theme, and regressions in neighbouring features.

Do not change code. Finish with the environment details (URLs, PIDs, where credentials come from, how to stop everything), then the complete QA plan.`,
    }),
    step({
      id: "qa",
      name: "QA",
      modelSelection: claude("claude-sonnet-5-5", "high"),
      runtimeMode: "full-access",
      promptTemplate: `Execute this QA plan against the running app and fix what you find.

Environment and QA plan:
{{previous.output}}

Requirements:
{{steps.requirements.output}}

- Work through every task. Split independent areas across subagents when you can, each with its own tasks.
- Drive the app with the browser or preview tools you have. Screenshot every checked state and save the screenshots outside the tracked tree (a gitignored or temp folder), named by task number.
- Inspect everything visually too: spacing, alignment, overflow, contrast, dark mode, responsive layouts, and whether new UI matches the rest of the app's components, wording and patterns.
- When something fails, find the root cause, fix it, add a regression test where it makes sense, and re-run the affected tasks.
- If the environment from the plan is not running, start it yourself. Stop the processes the plan started when you are done.

${GIT_AND_TRACKING}

Finish with a QA report: a table of tasks marked pass, fixed or open; each issue found and what you changed; the screenshot folder; remaining risks.`,
    }),
    step({
      id: "review",
      name: "Review",
      modelSelection: claude("claude-opus-5-5", "high"),
      runtimeMode: "full-access",
      promptTemplate: `You coordinate the code review of this change.

Requirements:
{{steps.requirements.output}}

Implementation:
{{steps.implement.output}}

QA report:
{{steps.qa.output}}

Launch several reviewer subagents in parallel (Claude Opus 5.5 with high effort where your tools let you choose), each reviewing the full diff against the base branch from one perspective: correctness and edge cases; requirements coverage; architecture and maintainability (duplication, fit with existing patterns); security and data safety; performance; tests; UX consistency. Give each the requirements and ask for concrete findings with file and line.

Verify every finding yourself and drop false positives. Fix the confirmed ones (or delegate the fixes), keep tests green, and re-review risky fixes.

${GIT_AND_TRACKING}
- When the review is done and nothing important is open, mark the pull request ready for review.

Finish with: confirmed findings and how each was resolved, rejected findings and why, and anything that still needs a human decision.`,
    }),
    step({
      id: "guide",
      name: "Visual review guide",
      modelSelection: claude("claude-sonnet-5-5", "medium"),
      runtimeMode: "full-access",
      promptTemplate: `Prepare a visual review guide for me, as if a coworker walks me through this change at their desk.

Requirements:
{{steps.requirements.output}}

QA report, with screenshot locations:
{{steps.qa.output}}

Review results:
{{steps.review.output}}

- Focus on what I can see: before and after screenshots (reuse the QA screenshots, take new ones where needed), simple diagrams of flows and how the pieces connect, and short, plain sentences. Keep the information density low: one idea per section.
- Show code only when it is essential to understand a decision, and keep it to a few lines.
- Order it as a walkthrough: what changed and why, each user-visible change, how it works behind the scenes, what QA and review found, and what I should look at or decide.
- Make it one self-contained HTML page with the images embedded, saved outside the tracked tree. Show it with your HTML preview tool if you have one, and link the pull request.

Do not change code. Finish with the path to the guide and a three-line summary.`,
    }),
  ],
};

export const PIPELINE_STARTERS: ReadonlyArray<PipelineStarter> = [FEATURE_DELIVERY_PIPELINE];
