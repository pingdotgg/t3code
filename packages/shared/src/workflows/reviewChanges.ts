import {
  DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE,
  type ReviewChangesScope,
  type ReviewChangesWorkflowSettings,
} from "@t3tools/contracts";

export const REVIEW_CHANGES_WORKFLOW_ID = "review-changes";

export const REVIEW_CHANGES_VARIANT_IDS = ["uncommitted", "against-base"] as const;
export type ReviewChangesVariantId = (typeof REVIEW_CHANGES_VARIANT_IDS)[number];

export type ReviewChangesPromptContext =
  | {
      readonly scope: "uncommitted";
    }
  | {
      readonly scope: "against-base";
      readonly baseBranch: string;
      readonly mergeBaseSha: string;
    };

export interface AgentWorkflowVariantDefinition<VariantId extends string = string> {
  readonly id: VariantId;
  readonly label: string;
  readonly contextProviders: ReadonlyArray<string>;
}

export interface AgentWorkflowDefinition<VariantId extends string = string> {
  readonly id: string;
  readonly label: string;
  readonly settingsKey: string;
  readonly defaultVariantId: VariantId;
  readonly variants: ReadonlyArray<AgentWorkflowVariantDefinition<VariantId>>;
}

export const REVIEW_CHANGES_WORKFLOW_DEFINITION = {
  id: REVIEW_CHANGES_WORKFLOW_ID,
  label: "Review Code",
  settingsKey: "reviewChanges",
  defaultVariantId: "uncommitted",
  variants: [
    {
      id: "uncommitted",
      label: "Uncommitted changes",
      contextProviders: ["uncommittedChanges"],
    },
    {
      id: "against-base",
      label: "Against base branch",
      contextProviders: ["reviewBase", "uncommittedChanges"],
    },
  ],
} as const satisfies AgentWorkflowDefinition<ReviewChangesVariantId>;

function promptTemplateOrDefault(promptTemplate: string): string {
  const trimmed = promptTemplate.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE;
}

function buildReviewChangesScopeContext(context: ReviewChangesPromptContext): string {
  switch (context.scope) {
    case "uncommitted":
      return `Review scope: uncommitted changes.

Use these commands to understand the scope:
- git diff --cached
- git diff
- git ls-files --others --exclude-standard

Review staged changes, unstaged changes, and untracked files.
Do not review already committed branch changes except as surrounding context.`;
    case "against-base":
      return `Review scope: changes against base branch.
Base branch: ${context.baseBranch}
Merge base: ${context.mergeBaseSha}

Use these commands to understand the scope:
- git diff ${context.mergeBaseSha}
- git status --short
- git ls-files --others --exclude-standard

Include committed branch changes, staged changes, unstaged changes, and untracked files.`;
    default: {
      const exhaustive: never = context;
      throw new Error(`Unhandled review changes scope: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function buildReviewChangesPrompt(input: {
  readonly context: ReviewChangesPromptContext;
  readonly settings: Pick<ReviewChangesWorkflowSettings, "promptTemplate">;
}): string {
  return `<context>
${buildReviewChangesScopeContext(input.context)}
</context>

<instructions>
${promptTemplateOrDefault(input.settings.promptTemplate)}

Return exactly one JSON object with no Markdown fences or surrounding text:
{"findings":[{"title":"[P1] short title","body":"explanation","confidence_score":0.0,"priority":1,"code_location":{"absolute_file_path":"/absolute/path/to/file","line_range":{"start":1,"end":1}}}],"overall_correctness":"patch is correct|patch is incorrect","overall_explanation":"short summary","overall_confidence_score":0.0}
</instructions>`;
}

export function reviewChangesVariantIdForScope(scope: ReviewChangesScope): ReviewChangesVariantId {
  return scope;
}
