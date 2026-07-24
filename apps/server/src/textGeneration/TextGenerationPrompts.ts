/**
 * Shared prompt builders for text generation providers.
 *
 * Extracts the prompt construction logic that is identical across
 * Codex, Claude, and any future CLI-based text generation backends.
 *
 * @module textGenerationPrompts
 */
import * as Schema from "effect/Schema";
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

// ---------------------------------------------------------------------------
// Thread review (work-review sweep)
// ---------------------------------------------------------------------------

export interface ThreadReviewMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface ThreadReviewPromptInput {
  title: string;
  /** True when the thread has a running session or pending approvals/input.
      Active threads must never get a settle recommendation. */
  isActive: boolean;
  firstUserMessage: string | null;
  recentMessages: ReadonlyArray<ThreadReviewMessage>;
  pullRequest?:
    | {
        number: number;
        state: "open" | "closed" | "merged";
        reviewDecision: string | null;
        checksPassing: boolean | null;
        mergeable: boolean | null;
        recentComments: ReadonlyArray<{ author: string; createdAt: string; body: string }>;
      }
    | undefined;
}

function renderPullRequestSection(
  pullRequest: NonNullable<ThreadReviewPromptInput["pullRequest"]>,
): string {
  const lines = [
    `PR #${pullRequest.number}: state=${pullRequest.state}`,
    `review decision: ${pullRequest.reviewDecision ?? "none required"}`,
    `CI checks passing: ${pullRequest.checksPassing === null ? "unknown" : String(pullRequest.checksPassing)}`,
    `mergeable: ${pullRequest.mergeable === null ? "unknown" : String(pullRequest.mergeable)}`,
  ];
  if (pullRequest.recentComments.length > 0) {
    lines.push("Recent PR comments (newest last):");
    for (const comment of pullRequest.recentComments) {
      lines.push(`[${comment.author} @ ${comment.createdAt}] ${comment.body}`);
    }
  }
  return lines.join("\n");
}

const THREAD_REVIEW_RECENT_MESSAGE_COUNT = 20;
const THREAD_REVIEW_MESSAGE_CHAR_LIMIT = 2_000;

export function buildThreadReviewPrompt(input: ThreadReviewPromptInput) {
  const recent = input.recentMessages.slice(-THREAD_REVIEW_RECENT_MESSAGE_COUNT);
  const transcript = recent
    .map(
      (message) =>
        `[${message.role}] ${limitSection(message.text, THREAD_REVIEW_MESSAGE_CHAR_LIMIT)}`,
    )
    .join("\n\n");

  const prompt = [
    "You review a coding-agent conversation thread and report its state.",
    "Return a JSON object with keys: summary, nextStep, suggestedTitle, recommendSettle, settleReason.",
    "Rules:",
    "- summary: ONE sentence, max ~25 words: what was asked and where it landed",
    "- nextStep: a COMMAND to the user, max 10 words. Start with a verb. Never describe status.",
    "  GOOD: 'Merge PR #4415.'",
    "  GOOD: 'Answer the agent's question about auth scopes.'",
    "  GOOD: 'Settle this thread.'",
    "  GOOD: 'Wait — agent still working.'",
    "  BAD: 'The requested comparison and hosted write-up are complete, and...' (status recap, not a command)",
    "  BAD: 'You should probably consider reviewing the PR when you have time.' (hedging filler)",
    "- suggestedTitle: a corrected 3-8 word title ONLY if the current title is misleading or a placeholder like 'New thread'; otherwise null",
    "- recommendSettle: true ONLY when the work clearly concluded (done, abandoned, or superseded) and nothing awaits the user",
    "- settleReason: one short sentence justifying recommendSettle, or null when recommendSettle is false",
    "- be conservative: when in doubt, do not suggest a title change and do not recommend settling",
    ...(input.isActive
      ? [
          "- this thread is still ACTIVE (running or awaiting the user): recommendSettle must be false",
        ]
      : []),
    ...(input.pullRequest
      ? [
          "- weigh the PR context heavily: an open PR awaiting the user's review/merge is NOT settleable; a merged PR with no follow-up work is",
          "- if the PR is open, CI is green, reviews approve it, and it is mergeable, nextStep should be to merge it",
        ]
      : []),
    "",
    `Current title: ${input.title}`,
    ...(input.pullRequest
      ? [
          "",
          "Pull request status:",
          limitSection(renderPullRequestSection(input.pullRequest), 6_000),
        ]
      : []),
    "",
    "First user message:",
    limitSection(input.firstUserMessage ?? "(none)", THREAD_REVIEW_MESSAGE_CHAR_LIMIT),
    "",
    `Most recent messages (up to ${THREAD_REVIEW_RECENT_MESSAGE_COUNT}):`,
    limitSection(transcript.length > 0 ? transcript : "(no messages)", 24_000),
  ].join("\n");

  const outputSchema = Schema.Struct({
    summary: Schema.String,
    nextStep: Schema.String,
    suggestedTitle: Schema.NullOr(Schema.String),
    recommendSettle: Schema.Boolean,
    settleReason: Schema.NullOr(Schema.String),
  });

  return { prompt, outputSchema };
}
