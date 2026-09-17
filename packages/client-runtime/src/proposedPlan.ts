import type { OrchestrationProposedPlan } from "@t3tools/contracts";

export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift();
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift();
    }
  }
  return sourceLines.join("\n");
}

export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: {
    maxLines?: number;
  },
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;

  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) {
      visibleLineCount += 1;
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  }

  if (hasMoreContent) {
    previewLines.push("", "...");
  }

  return previewLines.join("\n");
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

/** Prefix of the message the app sends when the user approves a plan. */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

export function resolvePlanFollowUpSubmission(input: { draftText: string; planMarkdown: string }): {
  text: string;
  interactionMode: "default" | "plan";
} {
  const trimmedDraftText = input.draftText.trim();
  if (trimmedDraftText.length > 0) {
    return {
      text: trimmedDraftText,
      interactionMode: "plan",
    };
  }

  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default",
  };
}

export function buildPlanImplementationThreadTitle(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  if (!title) {
    return "Implement plan";
  }
  return `Implement ${title}`;
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

export type ActiveProposedPlan = Readonly<
  Pick<
    OrchestrationProposedPlan,
    "id" | "turnId" | "planMarkdown" | "implementedAt" | "implementationThreadId"
  > & { readonly threadId: string }
>;

/**
 * Shell-level mirror of the server's actionable-plan flag: the latest proposed
 * plan has no implementation yet. Settled-turn and plan-mode gating stay with
 * the UI, as they do on the web thread status pill.
 */
export function hasUnimplementedProposedPlan(
  proposedPlans: ReadonlyArray<OrchestrationProposedPlan>,
): boolean {
  let selected: OrchestrationProposedPlan | undefined;
  for (const candidate of proposedPlans) {
    if (
      selected === undefined ||
      candidate.updatedAt.localeCompare(selected.updatedAt) >= 0 ||
      (candidate.updatedAt.localeCompare(selected.updatedAt) === 0 &&
        candidate.id.localeCompare(selected.id) >= 0)
    ) {
      selected = candidate;
    }
  }
  return selected?.implementedAt === null;
}

function planForLatestTurn(
  proposedPlans: ReadonlyArray<OrchestrationProposedPlan>,
  turnId: string | null,
): OrchestrationProposedPlan | null {
  const candidates = [...proposedPlans].sort(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
  );
  if (turnId !== null) {
    const matching = candidates.filter((plan) => plan.turnId === turnId).at(-1);
    if (matching) return matching;
  }
  return candidates.at(-1) ?? null;
}

/**
 * The plan the reader can still act on: the latest proposed plan belongs to the
 * settled latest turn, and nothing has implemented it yet. A running turn keeps
 * its plan hidden the same way the web composer's follow-up prompt waits for
 * the agent to finish.
 */
export function findActiveProposedPlan(input: {
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly latestTurn: {
    readonly turnId: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: { readonly status: string } | null;
  readonly threadId: string;
}): ActiveProposedPlan | null {
  const latestTurn = input.latestTurn;
  if (latestTurn === null || !latestTurn.startedAt || !latestTurn.completedAt) return null;
  if (input.session !== null && input.session.status === "running") return null;
  const plan = planForLatestTurn(input.proposedPlans, latestTurn.turnId);
  if (plan === null || plan.implementedAt !== null) return null;
  return { ...plan, threadId: input.threadId };
}
