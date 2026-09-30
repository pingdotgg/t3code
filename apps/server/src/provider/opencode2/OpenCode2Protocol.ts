/**
 * OpenCode2Protocol — shared pure helpers for the standalone `opencode2`
 * adapter split.
 *
 * Mirrors the v1 `opencodeRuntime.ts` helpers it replaces
 * (`parseOpenCodeModelSlug`, `toOpenCodeFileParts`,
 * `buildOpenCodePermissionRules`, `toOpenCodePermissionReply`,
 * `toOpenCodeQuestionAnswers`) without importing the v1 monolith, so the
 * `opencode2` driver compiles and tests standalone. The concrete v2 client
 * binding reuses these shapes; only the transport changes.
 *
 * @module provider/opencode2/OpenCode2Protocol
 */
import * as NodeURL from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";

import { OPENCODE2_DRIVER_KIND } from "../OpenCode2Settings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";

/**
 * Version tag stamped into the OpenCode 2 resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors v1 `OPENCODE_RESUME_VERSION`).
 */
export const OPENCODE2_RESUME_VERSION = 1 as const;

/** Durable resume cursor persisted on every session and turn result. */
export interface OpenCode2ResumeCursor {
  readonly schemaVersion: typeof OPENCODE2_RESUME_VERSION;
  readonly sessionId: string;
}

/**
 * Decode a persisted resume cursor into the upstream session id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
export function parseOpenCode2Resume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE2_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/** Build the resume cursor stamped onto sessions after create/reuse/fork. */
export function makeOpenCode2ResumeCursor(sessionId: string): OpenCode2ResumeCursor {
  return { schemaVersion: OPENCODE2_RESUME_VERSION, sessionId };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure must propagate,
 * or a transient blip resets a live thread to an empty one. Decides on
 * structured signals only (numeric 404 or the exact `NotFoundError` name via
 * a bounded walk over `cause`/`body`/`error`/`data`), never free text. An
 * explicit non-404 status seals its subtree so a wrapped "NotFound" name
 * can't reclassify a real failure (mirrors v1 `isOpenCodeNotFound`).
 */
export function isOpenCode2NotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

/**
 * Lexically normalize a directory spelling so raw string equality stops
 * misreading a trailing slash or `.`/`..` segment as a cwd change (which
 * would needlessly fork the session on every resume). Only widens matches;
 * true locations still compare equal after normalization. Path whitespace
 * is significant (trailing-space directories are legal on Linux), so only
 * separators and dot segments normalize — never trim.
 */
export function normalizeOpenCode2Directory(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutTrailing = value.length > 1 ? value.replace(/\/+$/, "") : value;
  const segments: Array<string> = [];
  for (const part of withoutTrailing.split("/")) {
    if (part === "" || part === ".") {
      if (segments.length === 0 && part === "") {
        segments.push("");
      }
      continue;
    }
    if (part === "..") {
      if (segments.length > 1 || (segments.length === 1 && segments[0] !== "")) {
        segments.pop();
      }
      continue;
    }
    segments.push(part);
  }
  return segments.join("/") || "/";
}

/** Lexically-equal paths short-circuit; otherwise both sides normalize first. */
export function isSameOpenCode2Directory(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return normalizeOpenCode2Directory(left) === normalizeOpenCode2Directory(right);
}

/**
 * Coerce user-input answers into a v2 form answer record (`Form.Answer`:
 * scalars pass through, arrays filter to strings, other values stringify,
 * nullish values are omitted).
 */
export function toOpenCode2FormAnswers(
  answers: Record<string, unknown>,
): Record<string, string | number | boolean | ReadonlyArray<string>> {
  const coerced: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  for (const [key, raw] of Object.entries(answers)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      coerced[key] = raw;
    } else if (Array.isArray(raw)) {
      coerced[key] = raw.filter((value): value is string => typeof value === "string");
    } else if (raw !== null && raw !== undefined) {
      coerced[key] = String(raw);
    }
  }
  return coerced;
}

/** Parsed `provider/model[#variant]` slug carried by every model selection. */
export interface ParsedOpenCode2ModelSlug {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string | undefined;
}

/**
 * Parse a `provider/model[#variant]` slug; null when the selection is
 * unusable. Mirrors upstream `Model.Ref.parse`: the `#variant` suffix splits
 * off first so it never corrupts the model id, and empty or `#`-bearing
 * segments reject the slug.
 */
export function parseOpenCode2ModelSlug(
  slug: string | null | undefined,
): ParsedOpenCode2ModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return null;
  }
  const variantStart = trimmed.indexOf("#", separator + 1);
  const providerID = trimmed.slice(0, separator);
  const modelID = trimmed.slice(separator + 1, variantStart === -1 ? undefined : variantStart);
  const variant = variantStart === -1 ? undefined : trimmed.slice(variantStart + 1);
  if (
    modelID.length === 0 ||
    providerID.includes("#") ||
    (variant !== undefined && (variant.length === 0 || variant.includes("#")))
  ) {
    return null;
  }
  return variant === undefined ? { providerID, modelID } : { providerID, modelID, variant };
}

/** Native file part handed to the model (mirrors v1 `FilePartInput`). */
export interface OpenCode2FilePartInput {
  readonly type: "file";
  readonly mime: string;
  readonly filename: string;
  readonly url: string;
}

/** Native text part handed to the model. */
export interface OpenCode2TextPartInput {
  readonly type: "text";
  readonly text: string;
}

export type OpenCode2PromptPartInput = OpenCode2FilePartInput | OpenCode2TextPartInput;

/**
 * Attachments OpenCode can hand to a model as a native file part: images,
 * text, and PDFs at or under 20 MiB, referenced by `file://` URI. Anything
 * else (ZIP, binaries, BMP/AVIF/SVG, oversized files, pasted-text folds)
 * rides only as the file path the caller puts in the prompt.
 */
const OPENCODE2_NATIVE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const OPENCODE2_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCode2NativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE2_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE2_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/pdf"
  );
}

export function toOpenCode2FileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<OpenCode2FilePartInput> {
  const parts: Array<OpenCode2FilePartInput> = [];
  for (const attachment of input.attachments ?? []) {
    // The unknown-attachment catch-all carries an open string discriminator,
    // so literal `type` guards cannot narrow it away — exclude by shape.
    if (!("mimeType" in attachment) || !("sizeBytes" in attachment) || !("name" in attachment)) {
      continue;
    }
    if (attachment.type === "file" && "source" in attachment) {
      const source = attachment.source as { readonly _tag?: string } | undefined;
      if (source?._tag === "pasted-text") {
        continue;
      }
    }
    if (!isOpenCode2NativeFilePart(attachment)) {
      continue;
    }
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }
    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }
  return parts;
}

/** Session permission rule (structural; bound to the v2 SDK type in the session client). */
export interface OpenCode2PermissionRule {
  readonly permission: string;
  readonly pattern: string;
  readonly action: "allow" | "ask" | "deny";
}

export type OpenCode2PermissionRuleset = ReadonlyArray<OpenCode2PermissionRule>;

/**
 * Permission ruleset per runtime mode. `full-access` allows everything;
 * `auto-accept-edits` auto-approves edits but asks otherwise; every other
 * mode asks by default while allowing reads/glob/grep/questions.
 */
export function buildOpenCode2PermissionRules(
  runtimeMode: RuntimeMode,
): OpenCode2PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  }
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: editAction },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

/** Map a provider approval decision onto the OpenCode reply vocabulary. */
export function toOpenCode2PermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

/** Minimal question shape for id/answer coercion (structural v2 draft). */
export interface OpenCode2QuestionLike {
  readonly header: string;
  readonly question: string;
}

/** Stable per-question id derived from position + slugified header. */
export function openCode2QuestionId(index: number, question: OpenCode2QuestionLike): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export interface OpenCode2QuestionRequestLike {
  readonly questions: ReadonlyArray<
    OpenCode2QuestionLike & {
      readonly options?: ReadonlyArray<{ readonly label: string }> | undefined;
    }
  >;
}

/**
 * Coerce user-input answers into per-question string arrays. Looks up each
 * answer by generated id, then raw header, then raw question text; arrays
 * pass through filtered to strings, single strings become one answer when
 * non-blank, everything else is an empty (skipped) answer.
 */
export function toOpenCode2QuestionAnswers(
  request: OpenCode2QuestionRequestLike,
  answers: Record<string, unknown>,
): Array<Array<string>> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCode2QuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Adapter-boundary error constructors (provider is always opencode2)
// ---------------------------------------------------------------------------

export const openCode2RequestError = (
  method: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: OPENCODE2_DRIVER_KIND,
    method,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const openCode2ProcessError = (
  threadId: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: OPENCODE2_DRIVER_KIND,
    threadId,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const openCode2ValidationError = (
  operation: string,
  issue: string,
): ProviderAdapterValidationError =>
  new ProviderAdapterValidationError({
    provider: OPENCODE2_DRIVER_KIND,
    operation,
    issue,
  });

export const openCode2SessionNotFoundError = (
  threadId: string,
): ProviderAdapterSessionNotFoundError =>
  new ProviderAdapterSessionNotFoundError({
    provider: OPENCODE2_DRIVER_KIND,
    threadId,
  });

export const openCode2SessionClosedError = (threadId: string): ProviderAdapterSessionClosedError =>
  new ProviderAdapterSessionClosedError({
    provider: OPENCODE2_DRIVER_KIND,
    threadId,
  });

/** Union of errors the opencode2 adapter surface can fail with. */
export type OpenCode2AdapterError = ProviderAdapterError;
