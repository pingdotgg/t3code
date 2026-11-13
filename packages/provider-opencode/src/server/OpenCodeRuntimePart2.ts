import * as NodeURL from "node:url";
import type { ChatAttachment, ProviderApprovalDecision } from "@t3tools/contracts";
import {
  type FilePartInput,
  type OpencodeClient,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import type { OpenCodeSlashCommand } from "./OpenCodeRuntime.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const OPENCODE_EMPTY_CONFIG_CONTENT = "{}";

export const MINIMUM_OPENCODE_VERSION = "1.14.19";

const OPENCODE_HEALTH_TIMEOUT = "5 seconds";

const OpenCodeHealthSchema = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
});

const decodeOpenCodeHealth = Schema.decodeUnknownEffect(OpenCodeHealthSchema);

export function resolveOpenCodeConfigContent(
  inputEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (
    inputEnvironment?.OPENCODE_CONFIG_CONTENT ??
    inheritedEnvironment.OPENCODE_CONFIG_CONTENT ??
    OPENCODE_EMPTY_CONFIG_CONTENT
  );
}

export function resolveOpenCodeServerPassword(
  input: {
    readonly external: boolean;
    readonly serverPassword?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (input.serverPassword !== undefined) {
    return input.serverPassword;
  }
  if (input.external) {
    return undefined;
  }
  return input.environment === undefined
    ? inheritedEnvironment.OPENCODE_SERVER_PASSWORD
    : input.environment.OPENCODE_SERVER_PASSWORD;
}

export const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;

export const DEFAULT_HOSTNAME = "127.0.0.1";

export const OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS = 64 * 1024;

export const OPENCODE_SERVER_EXIT_DRAIN_TIMEOUT = "500 millis";

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";

export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
  readonly reason?: OpenCodeStartupFailureReason;
}> {}

export type OpenCodeStartupFailureReason = "databaseLocked";

export // Classify stderr database locks at exit so callers need not parse diagnostics.
function classifyStartupExit(stderr: string): OpenCodeStartupFailureReason | undefined {
  return /SQLITE_BUSY|database is locked/i.test(stderr) ? "databaseLocked" : undefined;
}

export const isOpenCodeRuntimeError = (u: unknown): u is OpenCodeRuntimeError =>
  P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (isOpenCodeRuntimeError(cause)) return cause.detail;
  // Effect TimeoutError can have a non-string message.
  if (cause instanceof Error) {
    const message = cause.message;
    if (typeof message === "string") {
      const trimmedMessage = message.trim();
      if (trimmedMessage.length > 0) return trimmedMessage;
    }
  }
  if (cause && typeof cause === "object") {
    // SDK v2 throws response/request/error envelopes.
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export const verifyOpenCodeServerVersion = Effect.fn("verifyOpenCodeServerVersion")(function* (
  client: OpencodeClient,
) {
  const healthOption = yield* runOpenCodeSdk("global.health", (signal) =>
    client.global.health({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT));
  if (Option.isNone(healthOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }

  const health = yield* decodeOpenCodeHealth(healthOption.value.data).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntimeError({
          operation: "global.health",
          detail: `OpenCode server returned an invalid health response. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
          cause,
        }),
    ),
  );
  if (parseSemver(health.version) === null) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: `OpenCode server returned an invalid version. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  if (compareSemverVersions(health.version, MINIMUM_OPENCODE_VERSION) < 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: `OpenCode v${health.version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  return health.version;
});

export const loadOpenCodeCommands = (client: OpencodeClient) =>
  runOpenCodeSdk("command.list", (signal) => client.command.list(undefined, { signal })).pipe(
    Effect.map((result): ReadonlyArray<OpenCodeSlashCommand> =>
      (result.data ?? []).map(({ name, description, source, hints }) => ({
        name,
        ...(description === undefined ? {} : { description }),
        ...(source === undefined ? {} : { source }),
        hints,
      })),
    ),
  );

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = line.match(/server listening on\s+(https?:\/\/[^\s]+)/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

// OpenCode inlines only text/plain; other text MIME parts reach APIs that reject them.
const OPENCODE_NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const OPENCODE_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCodeNativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized === "text/plain" ||
    normalized === "application/pdf"
  );
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    if (!isOpenCodeNativeFilePart(attachment)) {
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

export function toOpenCodePermissionReply(
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

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
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
