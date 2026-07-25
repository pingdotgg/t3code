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

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

export interface ReasoningEffortChoicePromptInput {
  readonly id: string;
  readonly label: string;
}

export interface ReasoningEffortConversationEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ReasoningEffortPromptInput {
  /** The prompt whose difficulty is being judged. */
  message: string;
  /** Earlier turns of the same thread, oldest first. */
  conversation?: ReadonlyArray<ReasoningEffortConversationEntry> | undefined;
  /** Efforts the reviewer may pick, cheapest first, already clamped to the user's limits. */
  allowedEfforts: ReadonlyArray<ReasoningEffortChoicePromptInput>;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

/** Cap per-message context so a long thread cannot dominate the reviewer prompt. */
const REASONING_EFFORT_MESSAGE_LIMIT = 1_200;

function formatConversationEntry(entry: ReasoningEffortConversationEntry): string {
  const speaker = entry.role === "user" ? "User" : "Assistant";
  return `${speaker}: ${limitSection(entry.text.trim(), REASONING_EFFORT_MESSAGE_LIMIT)}`;
}

export function buildReasoningEffortPrompt(input: ReasoningEffortPromptInput) {
  const allowed = input.allowedEfforts;
  const cheapest = allowed[0];
  const costliest = allowed.at(-1);
  const conversation = input.conversation ?? [];
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );

  const promptSections = [
    "You size the reasoning effort a coding agent should spend on one request.",
    "Return a JSON object with keys: effort, reason.",
    "Rules:",
    `- effort must be exactly one of: ${allowed.map((option) => option.id).join(", ")}`,
    ...(cheapest
      ? [
          `- pick ${cheapest.id} for trivial work: reading a file, a one-line edit, a factual question, a rename, a restated instruction`,
        ]
      : []),
    ...(costliest && costliest.id !== cheapest?.id
      ? [
          `- pick ${costliest.id} only for genuinely hard work: cross-cutting refactors, debugging with unclear root cause, concurrency or protocol design, ambiguous requirements needing exploration`,
        ]
      : []),
    "- judge the work the request implies, not how politely or verbosely it is written",
    "- a long message that only pastes logs or context is not automatically hard",
    "- when the thread already established the context, weigh only the incremental work the new request adds",
    "- prefer the cheaper option when two are defensible",
    "- reason must be one short sentence naming the deciding factor",
    "",
    "Effort levels, cheapest first:",
    ...allowed.map((option) => `- ${option.id} (${option.label})`),
  ];

  if (conversation.length > 0) {
    promptSections.push(
      "",
      "Earlier messages in this thread (oldest first):",
      conversation.map(formatConversationEntry).join("\n"),
    );
  }

  promptSections.push("", "New request:", limitSection(input.message, 8_000));

  if (attachmentLines.length > 0) {
    promptSections.push(
      "",
      "Attachment metadata:",
      limitSection(attachmentLines.join("\n"), 4_000),
    );
  }

  return {
    prompt: promptSections.join("\n"),
    outputSchema: Schema.Struct({
      effort: Schema.String,
      reason: Schema.String,
    }),
  };
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
