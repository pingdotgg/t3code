import type {
  AutoReviewDecision,
  AutoReviewFindings,
  AutoReviewInlineComment,
  ModelSelection,
} from "@t3tools/contracts";
import { buildAutoReviewFooter, mapFindingsToDecision } from "@t3tools/shared/autoReview";
import type { GitHubPullRequestReviewCommentInput } from "../sourceControl/GitHubCli.ts";

export function partitionReviewComments(comments: ReadonlyArray<AutoReviewInlineComment>): {
  readonly anchorable: ReadonlyArray<GitHubPullRequestReviewCommentInput>;
  readonly unanchored: ReadonlyArray<AutoReviewInlineComment>;
} {
  const anchorable: GitHubPullRequestReviewCommentInput[] = [];
  const unanchored: AutoReviewInlineComment[] = [];

  for (const comment of comments) {
    const path = comment.path.trim();
    const body = comment.body.trim();
    if (!path || !body) {
      continue;
    }
    const line =
      comment.line !== null && Number.isSafeInteger(comment.line) && comment.line > 0
        ? comment.line
        : null;
    if (line === null) {
      unanchored.push(comment);
      continue;
    }
    anchorable.push({
      path,
      body: `**${comment.severity}:** ${body}`,
      line,
      side: comment.side === "LEFT" || comment.side === "RIGHT" ? comment.side : "RIGHT",
    });
  }

  return { anchorable, unanchored };
}

export function buildReviewBody(input: {
  readonly findings: AutoReviewFindings;
  readonly unanchored: ReadonlyArray<AutoReviewInlineComment>;
  readonly modelSelection: ModelSelection;
  readonly headSha: string;
}): string {
  const sections = [input.findings.summary.trim()];
  if (input.unanchored.length > 0) {
    sections.push(
      "",
      "### Could not anchor",
      ...input.unanchored.map(
        (comment) =>
          `- **${comment.severity}** \`${comment.path}\`${comment.line != null ? `:${comment.line}` : ""} — ${comment.body.trim()}`,
      ),
    );
  }
  sections.push(
    "",
    buildAutoReviewFooter({
      modelSelection: input.modelSelection,
      headSha: input.headSha,
    }),
  );
  return sections.join("\n").trim();
}

export function resolveReviewEvent(
  findings: AutoReviewFindings,
): Exclude<AutoReviewDecision, never> {
  // Server-side decision mapping wins over model-supplied decision.
  return mapFindingsToDecision(findings.comments);
}

export function normalizeFindings(findings: AutoReviewFindings): AutoReviewFindings {
  return {
    summary: findings.summary.trim(),
    decision: resolveReviewEvent(findings),
    comments: findings.comments
      .map((comment) => ({
        path: comment.path.trim(),
        line:
          comment.line !== null && Number.isSafeInteger(comment.line) && comment.line > 0
            ? comment.line
            : null,
        side: comment.side,
        severity: comment.severity,
        body: comment.body.trim(),
      }))
      .filter((comment) => comment.path.length > 0 && comment.body.length > 0),
  };
}
