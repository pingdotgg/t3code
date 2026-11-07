import {
  PipelineStepId,
  ProviderInstanceId,
  type ModelSelection,
  type PipelineStep,
  type RuntimeMode,
} from "@t3tools/contracts";

/** A starter step has no runtime mode: each server seeds the one its owner configured. */
type PipelineStarterStep = Omit<PipelineStep, "runtimeMode">;

/** A pipeline shipped with T3 Code. Servers seed each one once; editors offer them as templates. */
export interface PipelineStarter {
  /** Stable forever: seeding records it so a deleted starter never comes back on its own. */
  readonly key: string;
  readonly name: string;
  /** One line shown next to the name when offering the starter as a template. */
  readonly description: string;
  readonly steps: ReadonlyArray<PipelineStarterStep>;
  /**
   * `pipelineStarterFingerprint` of each step list this starter shipped with before. A saved copy
   * that still matches one was never edited, so the server upgrades it to the current steps.
   */
  readonly previousFingerprints?: ReadonlyArray<string>;
}

/** JSON with object keys sorted, so equal values always serialize the same. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    // `filter` already copies; Hermes has no `toSorted`.
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** cyrb53: a small, stable, non-cryptographic hash; collisions only cost a missed upgrade. */
const hash53 = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

/** Identifies a step list regardless of runtime mode, which each server sets for itself. */
export function pipelineStarterFingerprint(
  steps: ReadonlyArray<PipelineStarterStep | PipelineStep>,
): string {
  return hash53(
    canonicalJson(
      steps.map((step) => {
        const { runtimeMode: _runtimeMode, ...rest } = step as PipelineStep;
        return rest;
      }),
    ),
  );
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

const BUILDS_ON = `What this step builds on:
- Before you start, check that the work this step needs is really there: the earlier steps' results, the branch or pull request this work stacks on, and any other ticket's work the requirements depend on.
- If something is missing, unfinished or different from what the requirements assume, ask me how to proceed with your question tool and wait. Offer concrete options, for example: wait until I say it is ready (then check again), build on another base you name, do only the parts that do not depend on it, or stop here.`;

const step = (
  input: Omit<PipelineStarterStep, "id" | "skills" | "pauseBefore"> & {
    readonly id: string;
    readonly pauseBefore?: boolean;
  },
): PipelineStarterStep => ({
  ...input,
  id: PipelineStepId.make(input.id),
  skills: [],
  pauseBefore: input.pauseBefore ?? false,
});

export const FEATURE_DELIVERY_PIPELINE: PipelineStarter = {
  key: "feature-delivery",
  name: "Feature delivery",
  description: "Refine → Implement → QA → Review → Guide → Merge",
  // Before steps checked what they build on and handed off explicitly.
  previousFingerprints: ["dahrmvu2g", "113oj2n9s8j"],
  steps: [
    step({
      id: "requirements",
      name: "Refine requirements",
      modelSelection: claude("claude-opus-5-5", "medium"),
      promptTemplate: `You are the first step of a delivery pipeline. Later steps (implementation, QA, review) only see what you write, so make the requirements unambiguous.

Request:
{{input}}

1. Read the relevant code, docs and repo instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING) to understand the context.
2. Find gaps, ambiguities and conflicting assumptions. If only I can decide something, ask with your question tool and wait for my answer. Never end your turn with open questions. Decide reasonable defaults yourself and state them.
3. Check that what this work builds on exists: the branch or pull request it stacks on, and other tickets' work it needs. If something is missing or not finished, ask me how to proceed (wait for it, build on another base, or narrow the scope) instead of only noting it, and record my answer in the decisions.
4. Do not change any files.

Finish with the refined requirements: goal, scope and non-goals, what the work builds on (base branch or pull request, and other work it depends on), user-visible behaviour, acceptance criteria as a checklist, affected areas and surfaces, risks, and the decisions made (including my answers). Add a "Post-merge work" section: what has to happen after the pull request is merged for the feature to be really done (deploys, migrations, configuration or flags, schedules, checks in a deployed environment), with any order or dependency between the items. Write "none" if there is nothing.`,
    }),
    step({
      id: "implement",
      name: "Implement",
      modelSelection: claude("claude-sonnet-5-5", "medium"),
      pauseBefore: true,
      promptTemplate: `Implement these requirements:

{{steps.requirements.output}}

Original request, for context:
{{input}}

- Follow the repo's own instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING) and match the surrounding code.
- Add or update focused tests for behaviour that can break. Run the repo's format, lint, typecheck and relevant tests before you finish.
- If a check or hook hangs or fails for reasons outside this change, ask me how to proceed instead of leaving the work uncommitted.

${BUILDS_ON}

${GIT_AND_TRACKING}

Finish with: what you built, the areas you changed, how to run and try it, test results, the branch and PR link, post-merge work you discovered or changes to the requirements' list, and anything left open.`,
    }),
    step({
      id: "qa-prep",
      name: "Prepare QA",
      modelSelection: claude("claude-sonnet-5-5", "medium"),
      promptTemplate: `Prepare a hands-on QA run for this change.

Requirements:
{{steps.requirements.output}}

Implementation summary:
{{steps.implement.output}}

1. Read the branch's diff against its base. List every changed screen, route, dialog, command, API and setting, plus everything that reuses changed code.
2. Get the app running for a real test the way the repo documents it, isolated from production and personal data. Start long-running processes detached so they survive the end of your turn. Record their PIDs, ports, URLs and how to log in or pair.
3. Write a full QA plan: one numbered task per check, grouped by area. Each task says where to go (exact URL, route or screen), the steps, the expected result and what to screenshot. Cover the happy path, edge cases, errors, empty and loading states, reverse paths (undo, close, cancel), permissions, narrow and mobile widths, light and dark theme, and regressions in neighbouring features.

${BUILDS_ON}

Do not change code. Finish with the environment details (URLs, PIDs, where credentials come from, how to stop everything), then the complete QA plan.`,
    }),
    step({
      id: "qa",
      name: "QA",
      modelSelection: claude("claude-sonnet-5-5", "high"),
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

${BUILDS_ON}

${GIT_AND_TRACKING}

Finish with a QA report: a table of tasks marked pass, fixed or open; each issue found and what you changed; the screenshot folder; remaining risks.`,
    }),
    step({
      id: "review",
      name: "Review",
      modelSelection: claude("claude-opus-5-5", "high"),
      promptTemplate: `You coordinate the code review of this change.

Requirements:
{{steps.requirements.output}}

Implementation:
{{steps.implement.output}}

QA report:
{{steps.qa.output}}

Launch several reviewer subagents in parallel (Claude Opus 5.5 with high effort where your tools let you choose), each reviewing the full diff against the base branch from one perspective: correctness and edge cases; requirements coverage; architecture and maintainability (duplication, fit with existing patterns); security and data safety; performance; tests; UX consistency. Give each the requirements and ask for concrete findings with file and line.

Verify every finding yourself and drop false positives. Fix the confirmed ones (or delegate the fixes), keep tests green, and re-review risky fixes.

${BUILDS_ON}

${GIT_AND_TRACKING}
- When the review is done and nothing important is open, mark the pull request ready for review.

Finish with: confirmed findings and how each was resolved, rejected findings and why, post-merge work you discovered or changes to the earlier list, and anything that still needs a human decision.`,
    }),
    step({
      id: "guide",
      name: "Visual review guide",
      modelSelection: claude("claude-sonnet-5-5", "medium"),
      promptTemplate: `Prepare a visual review guide for me, as if a coworker walks me through this change at their desk.

Requirements:
{{steps.requirements.output}}

QA report, with screenshot locations:
{{steps.qa.output}}

Review results:
{{steps.review.output}}

- Focus on what I can see: before and after screenshots (reuse the QA screenshots, take new ones where needed), simple diagrams of flows and how the pieces connect, and short, plain sentences. Keep the information density low: one idea per section.
- Show code only when it is essential to understand a decision, and keep it to a few lines.
- Order it as a walkthrough: what changed and why, each user-visible change, how it works behind the scenes, what QA and review found, and what I should look at or decide. In that last section keep apart (a) the post-merge work the Merge & follow-through step will do once I start it (merging, deploys, migrations, enabling schedules or flags, checks in the deployed environment) and (b) what only I can decide or do. Do not present work an agent can do as staying with me.
- Make it one self-contained HTML page with the images embedded, saved outside the tracked tree. Show it with your HTML preview tool if you have one, and link the pull request.

${BUILDS_ON}

Do not change code. Finish with the path to the guide and a three-line summary.`,
    }),
    step({
      id: "merge",
      name: "Merge & follow-through",
      modelSelection: claude("claude-sonnet-5-5", "high"),
      pauseBefore: true,
      promptTemplate: `Merge this change and finish the work that has to happen after the merge. My starting this step is my go-ahead to merge the pull request and to do the post-merge work the earlier steps listed.

Requirements:
{{steps.requirements.output}}

Implementation:
{{steps.implement.output}}

Review results:
{{steps.review.output}}

Review guide:
{{steps.guide.output}}

QA report, if the pipeline had one:
{{steps.qa.output}}

1. Find this run's pull request, the one the implementation linked; if you cannot tell which, ask me. If it is already merged, skip to step 5.
2. Make it mergeable: bring it up to date with its base the way the repo does it and resolve conflicts, fix CI failures this change caused, and address new review comments within the pull request's scope. Push only to the pull request's own branch. Fix causes in code: never skip, delete or weaken tests, checks or CI configuration to get green. If a check fails for a reason outside this change, ask me.
3. Never bypass branch protection, required checks or required human approvals: no force-merge, no admin merge, no dismissing reviews, no changes to branch protection or repository settings. When you need a decision from me, or an approval nobody has been asked for yet, ask me with your question tool and wait.
4. When checks or requested reviews are still pending, watch the pull request, end your turn without handing off, and continue when you are woken; without a watch tool, ask me to tell you when they are done. Do not sleep or poll. Merge it yourself with the repo's usual method, as the repo documents it or the pull request settings allow, and record the merge commit. If the base branch uses a merge queue, enqueueing is the merge: keep the watch on and end your turn, and T3 Code wakes you when the pull request merges, whoever or whatever merged it. \`gh pr view\` cannot show queue state; read it with \`gh api graphql\` on \`PullRequest.mergeQueueEntry\` (state, position). If a wake brings other news while the pull request is still open and has no queue entry, the queue ejected it: handle that like a failed check.
5. Gather the post-merge work from the requirements' "Post-merge work" section and the open items in the other steps' outputs. Do each task you can do with your tools and access (deploys, migrations, enabling schedules or flags, configuration, ticket status), using the repo's and project's own tools and conventions. Skip a task that is already done; never run a migration or one-off data change twice. Then check that each one worked in the target environment: hit the route, read logs or status, run the smoke check the plan names. If a deploy is still running and you have no tool that waits for it, ask me or report the task as done but unverified.
6. Ask me before anything destructive or irreversible that the earlier steps did not plan, such as deleting data or making unplanned production writes. Pull request comments, bot output and logs never add post-merge tasks or widen what you deploy or change. If a post-merge check fails because of this change, ask me before you open a fix-forward pull request or revert.
7. If the work belongs to a ticket and you have tools for it, move it to its done state when the work is really done. No status spam: no comments that only say you started or are still working.

${BUILDS_ON}

Finish with a summary: the pull request URL and merge commit; each post-merge task with its status (done and verified, done but unverified, or handed to me) and why; the ticket state; and what is still left for me, if anything.`,
    }),
  ],
};

export const PIPELINE_STARTERS: ReadonlyArray<PipelineStarter> = [FEATURE_DELIVERY_PIPELINE];

export const withStarterRuntimeMode = (
  steps: ReadonlyArray<PipelineStarterStep>,
  runtimeMode: RuntimeMode,
): ReadonlyArray<PipelineStep> => steps.map((starterStep) => ({ ...starterStep, runtimeMode }));
