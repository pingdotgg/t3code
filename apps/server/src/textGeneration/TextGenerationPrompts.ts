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

const EARLIER_CONTENT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";

function policyInstruction(instruction: string | undefined): ReadonlyArray<string> {
  const trimmed = instruction?.trim();
  return trimmed ? ["", "Additional instructions:", limitSection(trimmed, 20_000)] : [];
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

export interface CommitMessagePromptInput {
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
}

export function buildCommitMessagePrompt(input: CommitMessagePromptInput) {
  const wantsBranch = input.includeBranch === true;

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
// Change request content
// ---------------------------------------------------------------------------

export interface PrContentPromptInput {
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
}

export function buildPrContentPrompt(input: PrContentPromptInput) {
  const changeRequestTemplate = input.changeRequestTemplate?.trim();
  const bodyRules = changeRequestTemplate
    ? [
        "- body must be markdown and follow the repository change request template structure",
        "- fill in the template sections appropriately for this change",
        "- drop HTML comments from the template in the generated body",
        "- keep the template's markdown structure",
      ]
    : [
        "- body must be markdown and include headings '## Summary' and '## Testing'",
        "- under Summary, provide short bullet points",
        "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      ];
  const prompt = [
    "You write source control change request content.",
    "Return a JSON object with keys: title, body.",
    "Rules:",
    "- title should be concise and specific",
    ...bodyRules,
    ...policyInstruction(input.policy?.changeRequestInstructions),
    ...(changeRequestTemplate
      ? ["", "Repository change request template:", limitSection(changeRequestTemplate, 8_000)]
      : []),
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
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  policy?: TextGenerationPolicy | undefined;
}

// Keep shared editorial rules in these two prompts in sync. Regeneration
// intentionally adds guidance for thread history and the previous title.
const INITIAL_THREAD_TITLE_PROMPT = `Generate a title that will help the user recognize this T3 Code thread weeks later.
Return JSON with exactly one key: title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when linked or attached context reveals the subject.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid project names already visible in the UI, quotes, labels, filler, and trailing punctuation.
- Use attached images as primary context for UI issues.
- When a URL or attachment is the only source of the subject, use available tools to inspect it. If it cannot be resolved, remain accurate rather than guessing.`;

function regenerateThreadTitlePrompt(previousTitle: string): string {
  return `Regenerate the title for an existing T3 Code thread so the user can recognize it weeks later.
The previous title was ${JSON.stringify(previousTitle)}.
Return JSON with exactly one key: title.

Determine the title in this order:
1. Read the USER messages first. Identify the latest explicit durable goal. The original subject remains the subject until the user clearly changes what the thread is about.
2. Use ASSISTANT messages to resolve vague links, unnamed code, and discovered product nouns. Do not promote one assistant finding into the thread subject unless the user adopts it as a new goal.
3. Compare that subject with the previous title. Preserve accurate scope words, especially when earlier content is truncated. Replace the previous title when it is generic, artifact-based, a completion update, or contradicted by the thread.
4. Title the durable subject and desired outcome, not the current workflow state.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Preserve the umbrella subject when later messages focus on one finding, provider, platform, or implementation detail.
- A thread progressing through research, planning, implementation, review, CI, merge, and monitoring has usually not changed subjects.
- Ignore deliverables and operations such as mocks, plans, HTML, branches, PRs, tests, CI, commits, merging, and monitoring unless they are the actual topic.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- Treat final operational follow-ups and assistant completion summaries as weak evidence of subject.
- For reviews, name the reviewed feature or system and its durable concern, not one finding from the review.
- For research, name the question domain rather than the research process.
- Do not claim the work is complete.
- Do not copy and truncate a thread message.
- Avoid project names already visible in the UI, PR numbers, quotes, labels, filler, and trailing punctuation.
- Use attached images as primary context for UI issues.
- When a URL or attachment is the only source of the subject, use available tools to inspect it. If it cannot be resolved, remain accurate rather than guessing.
- Return a meaningfully improved title, not a cosmetic paraphrase of the previous title.

Examples of the distinction:
- A subagent-monitoring review that finds a Codex roster bug remains "Review Subagent Monitoring Risks," not "Codex Roster Bug Review."
- A vague failing-test request later identified as a lazy thread-feed mismatch becomes "Fix Lazy Thread Feed Test," not "Prevent Mobile Feed Regressions."
- A QR-sharing overhaul that ends with CI and merge work remains about QR sharing, not the PR lifecycle.`;
}

function preserveMessageEnd(message: string): string {
  const alreadyTruncated = message.startsWith(EARLIER_CONTENT_TRUNCATION_MARKER);
  const contents = alreadyTruncated
    ? message.slice(EARLIER_CONTENT_TRUNCATION_MARKER.length)
    : message;
  if (!alreadyTruncated && contents.length <= 8_000) {
    return contents;
  }
  return `${EARLIER_CONTENT_TRUNCATION_MARKER}${contents.slice(-8_000)}`;
}

function threadTitlePromptSuffix(input: ThreadTitlePromptInput): string {
  const additionalInstructions = policyInstruction(input.policy?.threadTitleInstructions);
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );

  let suffix = "";
  if (additionalInstructions.length > 0) {
    suffix = `\n${additionalInstructions.join("\n")}`;
  }
  if (attachmentLines.length > 0) {
    suffix += `\n\nAttachment metadata:\n${limitSection(attachmentLines.join("\n"), 4_000)}`;
  }
  return suffix;
}

export function buildThreadTitlePrompt(input: ThreadTitlePromptInput) {
  let prompt: string;
  if (input.previousTitle === undefined) {
    const message = limitSection(input.message, 8_000);
    prompt = `${INITIAL_THREAD_TITLE_PROMPT}\n\nUser message:\n${message}${threadTitlePromptSuffix(input)}`;
  } else {
    const message = preserveMessageEnd(input.message);
    prompt = `${regenerateThreadTitlePrompt(input.previousTitle)}\n\nThread contents:\n${message}${threadTitlePromptSuffix(input)}`;
  }
  const outputSchema = Schema.Struct({
    title: Schema.String,
  });

  return { prompt, outputSchema };
}
