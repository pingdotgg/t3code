/**
 * Shared prompt builders for text generation providers.
 *
 * Extracts the prompt construction logic that is identical across
 * Codex, Claude, and any future CLI-based text generation backends.
 *
 * @module textGenerationPrompts
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import type { ChatAttachment } from "@t3tools/contracts";

import { limitSection } from "./TextGenerationUtils.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

function policyInstruction(instruction: string | undefined): ReadonlyArray<string> {
  const trimmed = instruction?.trim();
  return trimmed ? ["", "Additional instructions:", limitSection(trimmed, 4_000)] : [];
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

export interface CommitMessagePromptInput {
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch: boolean;
  policy?: TextGenerationPolicy | undefined;
}

export function buildCommitMessagePrompt(input: CommitMessagePromptInput) {
  const wantsBranch = input.includeBranch;

  const prompt = [
    "You write concise git commit messages.",
    wantsBranch
      ? "Return a JSON object with keys: subject, body, branch."
      : "Return a JSON object with keys: subject, body.",
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    ...(wantsBranch
      ? ["- branch must be a short semantic git branch fragment for this change"]
      : []),
    "- capture the primary user-visible or developer-visible change",
    ...policyInstruction(input.policy?.commitInstructions),
    "",
    `Branch: ${input.branch ?? "(detached)"}`,
    "",
    "Staged files:",
    limitSection(input.stagedSummary, 6_000),
    "",
    "Staged patch:",
    limitSection(input.stagedPatch, 40_000),
  ].join("\n");

  if (wantsBranch) {
    return {
      prompt,
      outputSchema: Schema.Struct({
        subject: Schema.String,
        body: Schema.String,
        branch: Schema.String,
      }),
    };
  }

  return {
    prompt,
    outputSchema: Schema.Struct({
      subject: Schema.String,
      body: Schema.String,
    }),
  };
}

// ---------------------------------------------------------------------------
// PR content
// ---------------------------------------------------------------------------

export interface PrContentPromptInput {
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  policy?: TextGenerationPolicy | undefined;
}

export function buildPrContentPrompt(input: PrContentPromptInput) {
  const prompt = [
    "You write GitHub pull request content.",
    "Return a JSON object with keys: title, body.",
    "Rules:",
    "- title should be concise and specific",
    "- body must be markdown and include headings '## Summary' and '## Testing'",
    "- under Summary, provide short bullet points",
    "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
    ...policyInstruction(input.policy?.changeRequestInstructions),
    "",
    `Base branch: ${input.baseBranch}`,
    `Head branch: ${input.headBranch}`,
    "",
    "Commits:",
    limitSection(input.commitSummary, 12_000),
    "",
    "Diff stat:",
    limitSection(input.diffSummary, 12_000),
    "",
    "Diff patch:",
    limitSection(input.diffPatch, 40_000),
  ].join("\n");

  const outputSchema = Schema.Struct({
    title: Schema.String,
    body: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Auto-review findings
// ---------------------------------------------------------------------------

export interface AutoReviewFindingsPromptInput {
  prNumber: number;
  prTitle: string;
  prBody: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diffPatch: string;
  truncated: boolean;
}

export function buildAutoReviewFindingsPrompt(input: AutoReviewFindingsPromptInput) {
  const prompt = [
    "You are a senior code reviewer for a GitHub pull request.",
    "Return a JSON object with keys: summary, decision, comments.",
    "Rules:",
    "- summary is markdown for the PR review body (concise, high signal)",
    "- decision must be one of: comment, request_changes, approve",
    "- prefer few high-signal comments over spam",
    "- focus on correctness, security, regressions, missing tests, and API contract breaks",
    "- comments[].path is a repo-relative file path",
    "- comments[].line is the new-file (RIGHT) line number when known, else null",
    "- comments[].side is LEFT, RIGHT, or null",
    "- comments[].severity is one of: blocking, important, nit, info",
    "- comments[].body is markdown explaining the issue and a fix direction",
    "- only mark severity blocking for true correctness/security problems",
    "- if the diff is truncated, say so in summary",
    "",
    `PR #${input.prNumber}: ${input.prTitle}`,
    `Base: ${input.baseBranch}`,
    `Head: ${input.headBranch} (${input.headSha})`,
    `Diff truncated: ${input.truncated ? "yes" : "no"}`,
    "",
    "PR body:",
    limitSection(input.prBody || "(empty)", 6_000),
    "",
    "Diff patch:",
    limitSection(input.diffPatch, 40_000),
  ].join("\n");

  const outputSchema = Schema.Struct({
    summary: Schema.String,
    decision: Schema.Literals(["comment", "request_changes", "approve"]),
    comments: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        line: Schema.NullOr(Schema.Number),
        side: Schema.NullOr(Schema.Literals(["LEFT", "RIGHT"])),
        severity: Schema.Literals(["blocking", "important", "nit", "info"]),
        body: Schema.String,
      }),
    ),
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Lenient auto-review findings decoding
//
// Agent-CLI providers that stream freeform text (Grok, Kimi) often return
// near-miss JSON: uppercase severities, string line numbers, extra keys, or
// a few malformed comments. Hard-failing the whole payload on the first
// schema mismatch burns retries, so decode leniently instead: coerce what we
// can, drop malformed comments, and only fail when nothing usable remains.
// Providers with API-side structured output (Codex, Claude) keep the strict
// schema above, since their CLI enforces it during generation.
// ---------------------------------------------------------------------------

const AUTO_REVIEW_DECISIONS: ReadonlySet<string> = new Set([
  "comment",
  "request_changes",
  "approve",
]);
const AUTO_REVIEW_SEVERITIES: ReadonlySet<string> = new Set([
  "blocking",
  "important",
  "nit",
  "info",
]);

const StrictAutoReviewFindingsSchema = Schema.Struct({
  summary: Schema.String,
  decision: Schema.Literals(["comment", "request_changes", "approve"]),
  comments: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.NullOr(Schema.Number),
      side: Schema.NullOr(Schema.Literals(["LEFT", "RIGHT"])),
      severity: Schema.Literals(["blocking", "important", "nit", "info"]),
      body: Schema.String,
    }),
  ),
});

type AutoReviewFindingsOutput = typeof StrictAutoReviewFindingsSchema.Type;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function coerceLineNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Best-effort sanitize of raw model JSON into the auto-review findings shape.
 * Returns `undefined` when the payload carries no usable review content.
 */
export function sanitizeAutoReviewFindingsJson(raw: unknown): AutoReviewFindingsOutput | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const summary = typeof record.summary === "string" ? record.summary : "";
  const decisionRaw =
    typeof record.decision === "string" ? record.decision.trim().toLowerCase() : "";
  const decision = (
    AUTO_REVIEW_DECISIONS.has(decisionRaw) ? decisionRaw : "comment"
  ) as AutoReviewFindingsOutput["decision"];

  const comments: AutoReviewFindingsOutput["comments"][number][] = [];
  for (const item of Array.isArray(record.comments) ? record.comments : []) {
    const comment = asRecord(item);
    if (!comment) {
      continue;
    }
    const path = typeof comment.path === "string" ? comment.path.trim() : "";
    const body = typeof comment.body === "string" ? comment.body.trim() : "";
    if (!path || !body) {
      continue;
    }
    const severityRaw =
      typeof comment.severity === "string" ? comment.severity.trim().toLowerCase() : "";
    const sideRaw = typeof comment.side === "string" ? comment.side.trim().toUpperCase() : "";
    comments.push({
      path,
      body,
      line: coerceLineNumber(comment.line),
      side: sideRaw === "LEFT" || sideRaw === "RIGHT" ? (sideRaw as "LEFT" | "RIGHT") : null,
      severity: (AUTO_REVIEW_SEVERITIES.has(severityRaw)
        ? severityRaw
        : "info") as AutoReviewFindingsOutput["comments"][number]["severity"],
    });
  }

  if (!summary.trim() && comments.length === 0) {
    return undefined;
  }
  return { summary, decision, comments };
}

/**
 * Decode-side schema for freeform-text providers. Sanitizes near-miss model
 * output before strict validation so a single malformed field does not fail
 * the whole review.
 */
export const LenientAutoReviewFindingsSchema = Schema.Unknown.pipe(
  Schema.decodeTo(
    StrictAutoReviewFindingsSchema,
    SchemaTransformation.transformOrFail<AutoReviewFindingsOutput, unknown>({
      decode: (raw) => {
        const sanitized = sanitizeAutoReviewFindingsJson(raw);
        return sanitized
          ? Effect.succeed(sanitized)
          : Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(raw), {
                message:
                  "Expected an auto-review findings object with a non-empty summary or at least one comment.",
              }),
            );
      },
      encode: (value) => Effect.succeed(value),
    }),
  ),
);

// ---------------------------------------------------------------------------
// Branch name
// ---------------------------------------------------------------------------

export interface BranchNamePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  policy?: TextGenerationPolicy | undefined;
}

interface PromptFromMessageInput {
  instruction: string;
  responseShape: string;
  rules: ReadonlyArray<string>;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  additionalInstructions?: string | undefined;
}

function buildPromptFromMessage(input: PromptFromMessageInput): string {
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );

  const promptSections = [
    input.instruction,
    input.responseShape,
    "Rules:",
    ...input.rules.map((rule) => `- ${rule}`),
    "",
    "User message:",
    limitSection(input.message, 8_000),
    ...policyInstruction(input.additionalInstructions),
  ];
  if (attachmentLines.length > 0) {
    promptSections.push(
      "",
      "Attachment metadata:",
      limitSection(attachmentLines.join("\n"), 4_000),
    );
  }

  return promptSections.join("\n");
}

export function buildBranchNamePrompt(input: BranchNamePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You generate concise git branch names.",
    responseShape: "Return a JSON object with key: branch.",
    rules: [
      "Branch should describe the requested work from the user message.",
      "Keep it short and specific (2-6 words).",
      "Use plain words only, no issue prefixes and no punctuation-heavy text.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
    additionalInstructions: input.policy?.branchInstructions,
  });
  const outputSchema = Schema.Struct({
    branch: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Thread title
// ---------------------------------------------------------------------------

export interface ThreadTitlePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  policy?: TextGenerationPolicy | undefined;
}

export function buildThreadTitlePrompt(input: ThreadTitlePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You write concise thread titles for coding conversations.",
    responseShape: "Return a JSON object with key: title.",
    rules: [
      "Title should summarize the user's request, not restate it verbatim.",
      "Keep it short and specific (3-8 words).",
      "Avoid quotes, filler, prefixes, and trailing punctuation.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
    additionalInstructions: input.policy?.threadTitleInstructions,
  });
  const outputSchema = Schema.Struct({
    title: Schema.String,
  });

  return { prompt, outputSchema };
}
