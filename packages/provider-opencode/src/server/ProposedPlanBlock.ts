const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

export const PROPOSED_PLAN_BLOCK_INSTRUCTIONS = `When you present the final plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec. If the user asks for revisions after a prior \`<proposed_plan>\`, any new \`<proposed_plan>\` must be a complete replacement.

Do not ask "should I proceed?" in the final output. The user can switch out of plan mode to implement, or stay in plan mode to keep refining.`;

export interface ProposedPlanSplit {
  readonly prose: string;
  readonly plan: string | null;
  readonly planComplete: boolean;
}

/**
 * Splits assistant text into prose and an optional `<proposed_plan>` block.
 * Safe to call on partially streamed text: an incomplete block yields the plan
 * so far, and a trailing partial opening tag is kept out of the prose.
 */
export function splitProposedPlanBlock(text: string): ProposedPlanSplit {
  const openMatch = /(^|\n)[ \t]*<proposed_plan>[ \t]*(\r?\n|$)/.exec(text);
  if (openMatch === null) {
    let prose = text;
    const lineStart = text.lastIndexOf("\n") + 1;
    const lastLine = text.slice(lineStart).trim();
    if (lastLine.length > 0 && OPEN_TAG.startsWith(lastLine)) {
      prose = text.slice(0, lineStart).trimEnd();
    }
    return { prose, plan: null, planComplete: false };
  }
  const before = text.slice(0, openMatch.index);
  const bodyStart = openMatch.index + openMatch[0].length;
  const rest = text.slice(bodyStart);
  const closeMatch = /(^|\n)[ \t]*<\/proposed_plan>[ \t]*(\r?\n|$)/.exec(rest);
  if (closeMatch === null) {
    let plan = rest;
    const lineStart = rest.lastIndexOf("\n") + 1;
    const lastLine = rest.slice(lineStart).trim();
    if (lastLine.length > 0 && CLOSE_TAG.startsWith(lastLine)) {
      plan = rest.slice(0, lineStart);
    }
    return { prose: before.trim(), plan: plan.trim() === "" ? null : plan, planComplete: false };
  }
  const closeIndex = closeMatch.index;
  const after = rest.slice(closeIndex + closeMatch[0].length);
  const plan = rest.slice(0, closeIndex).trim();
  return {
    prose: [before.trim(), after.trim()].filter(Boolean).join("\n\n"),
    plan: plan === "" ? null : plan,
    planComplete: plan !== "",
  };
}
