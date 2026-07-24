import {
  DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE,
  type FixReviewIssuesWorkflowSettings,
} from "@t3tools/contracts";

export const FIX_REVIEW_ISSUES_WORKFLOW_ID = "fix-review-issues";

function promptTemplateOrDefault(promptTemplate: string): string {
  const trimmed = promptTemplate.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE;
}

export function buildFixReviewIssuesPrompt(input: {
  readonly issues: string;
  readonly settings: Pick<FixReviewIssuesWorkflowSettings, "promptTemplate">;
}): string {
  return `<instructions>
${promptTemplateOrDefault(input.settings.promptTemplate)}
</instructions>

<review-issues>
${input.issues.trim()}
</review-issues>`;
}
