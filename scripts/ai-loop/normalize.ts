import { createStableHash } from "./hash";
import { AI_LOOP_SCHEMA_VERSION, type AiLoopFinding } from "./schema";

export interface ReviewCommentInput {
  actor: string;
  url: string;
  body: string;
  path: string;
  line: number;
  headSha: string;
}

export interface ReviewSummaryInput {
  actor: string;
  url: string;
  body: string;
  headSha: string;
}

export interface FailedCheckInput {
  actor: string;
  url: string;
  name: string;
  title: string;
  summary: string;
  headSha: string;
}

const BLOCKLIST_PATTERNS = [
  /ignore previous instructions/gi,
  /delete files/gi,
  /drop database/gi,
  /sudo\b/gi,
  /curl .*sh/gi,
];

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const stripPromptArtifacts = (body: string): string => {
  const withoutCode = body.replace(/```[\s\S]*?```/g, " ");
  const withoutQuotes = withoutCode.replace(/^>.*$/gm, " ");
  const withoutHtml = withoutQuotes.replace(/<[^>]+>/g, " ");
  const withoutMentions = withoutHtml.replace(/@[A-Za-z0-9_.-]+/g, " ");
  const withoutCommands = withoutMentions.replace(/^\/[A-Za-z0-9_-]+.*$/gm, " ");

  const scrubbedLines = withoutCommands
    .split("\n")
    .map((line) => {
      let next = line;
      for (const pattern of BLOCKLIST_PATTERNS) {
        next = next.replace(pattern, " ");
      }
      return next;
    })
    .filter((line) => normalizeWhitespace(line).length > 0);

  return normalizeWhitespace(scrubbedLines.join(" "));
};

const splitMessageAndEvidence = (body: string): { message: string; evidence: string } => {
  const sanitized = stripPromptArtifacts(body);
  const message = sanitized.slice(0, 220).trim();
  const evidence = sanitized.slice(0, 400).trim();

  return { message, evidence };
};

export const buildFindingFingerprint = (
  source: string,
  kind: string,
  path: string,
  line: number,
  normalizedMessage: string,
): string =>
  createStableHash(
    [source, kind, path, String(line), normalizeWhitespace(normalizedMessage)].join("|"),
  );

export const buildFindingSetFingerprint = (findings: AiLoopFinding[], headSha: string): string => {
  const sorted = [...findings].map((finding) => finding.fingerprint).sort();
  return createStableHash([headSha, ...sorted].join("|"));
};

export const normalizeReviewCommentFinding = (input: ReviewCommentInput): AiLoopFinding | null => {
  const { message, evidence } = splitMessageAndEvidence(input.body);
  if (!message) {
    return null;
  }

  return {
    schema_version: AI_LOOP_SCHEMA_VERSION,
    source: "review-comment",
    source_actor: input.actor,
    source_url: input.url,
    kind: "review-comment",
    path: input.path,
    line: input.line,
    severity: "medium",
    message,
    evidence,
    fingerprint: buildFindingFingerprint(
      "review-comment",
      "review-comment",
      input.path,
      input.line,
      message,
    ),
    head_sha: input.headSha,
    category: "review",
  };
};

export const normalizeReviewSummaryFinding = (input: ReviewSummaryInput): AiLoopFinding | null => {
  const { message, evidence } = splitMessageAndEvidence(input.body);
  if (!message) {
    return null;
  }

  return {
    schema_version: AI_LOOP_SCHEMA_VERSION,
    source: "review-summary",
    source_actor: input.actor,
    source_url: input.url,
    kind: "review-summary",
    path: ".github",
    line: 1,
    severity: "medium",
    message,
    evidence,
    fingerprint: buildFindingFingerprint("review-summary", "review-summary", ".github", 1, message),
    head_sha: input.headSha,
    category: "review",
  };
};

export const normalizeFailedCheckFinding = (input: FailedCheckInput): AiLoopFinding | null => {
  const { message, evidence } = splitMessageAndEvidence(`${input.title}\n${input.summary}`);
  if (!message) {
    return null;
  }

  return {
    schema_version: AI_LOOP_SCHEMA_VERSION,
    source: "check-run",
    source_actor: input.actor,
    source_url: input.url,
    kind: input.name,
    path: ".github/workflows",
    line: 1,
    severity: "high",
    message,
    evidence,
    fingerprint: buildFindingFingerprint("check-run", input.name, ".github/workflows", 1, message),
    head_sha: input.headSha,
    category: "ci",
  };
};

export const isAutofixTrigger = (body: string, triggerPhrase: string): boolean =>
  normalizeWhitespace(body) === normalizeWhitespace(triggerPhrase);
