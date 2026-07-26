import type {
  AutoReviewDecision,
  AutoReviewFindings,
  AutoReviewInlineComment,
  ModelSelection,
} from "@t3tools/contracts";
import { buildAutoReviewFooter, mapFindingsToDecision } from "@t3tools/shared/autoReview";
import type { GitHubPullRequestReviewCommentInput } from "../sourceControl/GitHubCli.ts";
import { normalizeCommentPath, resolveCommentAnchor, type DiffAnchors } from "./diffAnchors.ts";

/**
 * Split findings into comments GitHub will accept inline and comments that
 * have to live in the review body.
 *
 * `anchors` is the diff index for the reviewed head. A comment survives as
 * inline only when its (path, line, side) exists in the diff — GitHub 422s the
 * whole submission otherwise, which would drop the review entirely rather than
 * just the bad comment. Passing `null` skips the check (callers without a
 * parsed diff).
 */
export function partitionReviewComments(
  comments: ReadonlyArray<AutoReviewInlineComment>,
  anchors: DiffAnchors | null = null,
): {
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
    const requestedSide = comment.side === "LEFT" || comment.side === "RIGHT" ? comment.side : null;
    const side =
      anchors === null
        ? (requestedSide ?? "RIGHT")
        : resolveCommentAnchor({ anchors, path, line, side: requestedSide });
    if (side === null) {
      unanchored.push(comment);
      continue;
    }
    anchorable.push({
      path: anchors === null ? path : normalizeCommentPath(path),
      body: `**${comment.severity}:** ${body}`,
      line,
      side,
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
