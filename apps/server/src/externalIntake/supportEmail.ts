// @effect-diagnostics globalFetch:off

import { Buffer } from "node:buffer";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const RESEND_API_BASE_URL = "https://api.resend.com";
const SLACK_PREVIEW_MAX_CHARS = 2800;

export interface ResendReceivedEmailWebhook {
  readonly type?: unknown;
  readonly data?: {
    readonly email_id?: unknown;
  };
}

export interface ResendReceivedEmail {
  readonly id: string;
  readonly to?: readonly string[];
  readonly from?: string;
  readonly created_at?: string;
  readonly subject?: string | null;
  readonly html?: string | null;
  readonly text?: string | null;
  readonly headers?: Record<string, string>;
  readonly bcc?: readonly string[];
  readonly cc?: readonly string[];
  readonly reply_to?: readonly string[];
  readonly message_id?: string | null;
  readonly attachments?: ReadonlyArray<{
    readonly id?: string;
    readonly filename?: string | null;
    readonly content_type?: string | null;
    readonly content_disposition?: string | null;
    readonly content_id?: string | null;
  }>;
}

export interface SupportEmailContext {
  readonly productName?: string | undefined;
  readonly repoName?: string | undefined;
  readonly groupAddress?: string | undefined;
  readonly internalDomains?: readonly string[] | undefined;
  readonly adminUserUrlTemplate?: string | undefined;
  readonly postHogPersonUrlTemplate?: string | undefined;
}

export interface SupportEmailProfileContext {
  readonly productName?: string | undefined;
  readonly repoName?: string | undefined;
  readonly groupAddress?: string | undefined;
}

export interface StoredSupportEmailAttachment {
  readonly kind: "stored";
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly sizeBytes: number;
  readonly localPath: string;
  readonly nativeImageDataUrl?: string | undefined;
}

export interface FailedSupportEmailAttachment {
  readonly kind: "failed";
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly error: string;
}

export type ProcessedSupportEmailAttachment =
  | StoredSupportEmailAttachment
  | FailedSupportEmailAttachment;

function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function splitCsv(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? []
  );
}

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function supportEmailContextFromEnv(
  profile?: SupportEmailProfileContext | undefined,
): SupportEmailContext {
  const productName = profile?.productName ?? envValue("SUPPORT_EMAIL_PRODUCT_NAME");
  const groupAddress = profile?.groupAddress ?? envValue("SUPPORT_EMAIL_GROUP_ADDRESS");
  const repoName = profile?.repoName ?? envValue("SUPPORT_EMAIL_REPO_NAME");
  const adminUserUrlTemplate = envValue("SUPPORT_EMAIL_ADMIN_USER_URL_TEMPLATE");
  const postHogPersonUrlTemplate = envValue("SUPPORT_EMAIL_POSTHOG_PERSON_URL_TEMPLATE");
  const internalDomains = splitCsv(envValue("SUPPORT_EMAIL_INTERNAL_DOMAINS")).map((domain) =>
    domain.toLowerCase(),
  );
  return {
    ...(productName !== undefined ? { productName } : {}),
    ...(repoName !== undefined ? { repoName } : {}),
    ...(groupAddress !== undefined ? { groupAddress } : {}),
    ...(internalDomains.length > 0 ? { internalDomains } : {}),
    ...(adminUserUrlTemplate !== undefined ? { adminUserUrlTemplate } : {}),
    ...(postHogPersonUrlTemplate !== undefined ? { postHogPersonUrlTemplate } : {}),
  };
}

export function buildDefaultSupportEmailTriagePrompt(context: SupportEmailContext) {
  const productName = context.productName ?? "the configured product";
  const repoName = context.repoName ?? "the configured repo";
  const staffDomains = context.internalDomains?.join(", ") || "configured internal domains";
  const adminUserUrlTemplate =
    context.adminUserUrlTemplate ?? "the configured admin user URL for the affected account";
  const postHogPersonUrlTemplate =
    context.postHogPersonUrlTemplate ?? "the configured PostHog person URL for the affected user";

  return [
    `You are triaging a support email for ${productName}. Treat the issue as related to the ${repoName} repo unless the evidence clearly says otherwise.`,
    "",
    `Before doing any triage, decide whether the top-level email is actually from a user reporting an active issue. The email may be a follow-up from staff at ${staffDomains}, with quoted user context below it. If staff is saying the issue was fixed, asking the user for more information, asking the user to retry something, or otherwise handling the thread without a new user-reported problem, do not investigate the quoted issue. Respond briefly that no triage is needed and explain why.`,
    "",
    "Only do the triage work below when the current top-level message is clearly from a user with an active issue, or when staff is explicitly forwarding a user-reported issue for investigation.",
    "",
    "First classify the request: product bug, account/data issue, billing/subscription issue, user confusion, feature request, or spam/no-action. Not every email needs a code change.",
    "",
    `Identify the affected user or account from the email. Use Convex production data to find the related ${productName} user document. Report the Convex prod user document id, the admin URL using ${adminUserUrlTemplate}, and the Clerk id when present. Do not report Convex external ids.`,
    "",
    `Use PostHog CLI/MCP and the email details to find matching PostHog persons and activity around the likely time of the issue. Include full PostHog person URLs using ${postHogPersonUrlTemplate}. Do not use relative links. Summarize relevant recent events, sessions, errors, or absence of evidence.`,
    "",
    `Inspect the ${repoName} repo when code behavior is relevant, but do not make code changes and do not open a PR. If a code change appears necessary, describe the recommended change at a high level with the likely files or systems to inspect.`,
    "",
    "End with a concise triage summary: classification, user/account links, observed evidence, recommended next steps, and any missing information needed.",
  ].join("\n");
}

export function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function emailBody(email: ResendReceivedEmail) {
  const text = email.text?.trim();
  if (text) return text;

  const html = email.html?.trim();
  if (html) return htmlToText(html);

  return "(empty email body)";
}

export function truncateText(input: string, maxLength: number) {
  if (input.length <= maxLength) return input;
  const suffix = "\n...[truncated]";
  if (maxLength <= suffix.length) return suffix.slice(0, maxLength);
  return `${input.slice(0, maxLength - suffix.length)}${suffix}`;
}

function emailHeaderValue(email: ResendReceivedEmail, name: string) {
  const headers = email.headers ?? {};
  const header = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
  );
  return header?.[1];
}

export function normalizeEmailAddress(value: string) {
  const match = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i.exec(value);
  return match?.[1]?.toLowerCase();
}

function emailAddressesFromText(value: string | undefined) {
  if (value === undefined) return [];

  const addresses = new Set<string>();
  for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const normalized = normalizeEmailAddress(match[0]);
    if (normalized !== undefined) addresses.add(normalized);
  }
  return [...addresses];
}

function isSupportAddress(address: string, context: SupportEmailContext) {
  const supportAddress = context.groupAddress?.toLowerCase();
  return supportAddress !== undefined && address === supportAddress;
}

function isInternalEmailAddress(address: string, context: SupportEmailContext) {
  const [, domain] = address.split("@");
  return domain !== undefined && (context.internalDomains ?? []).includes(domain.toLowerCase());
}

function externalParticipantAddresses(email: ResendReceivedEmail, context: SupportEmailContext) {
  const values = [
    email.from,
    ...(email.reply_to ?? []),
    ...emailAddressesFromText(email.text ?? undefined),
    ...emailAddressesFromText(email.html ?? undefined),
  ];
  const addresses = new Set<string>();
  for (const value of values) {
    for (const address of emailAddressesFromText(value)) {
      if (!isSupportAddress(address, context) && !isInternalEmailAddress(address, context)) {
        addresses.add(address);
      }
    }
  }
  return [...addresses].toSorted();
}

function normalizedConversationSubject(email: ResendReceivedEmail) {
  const subject = email.subject?.trim();
  if (!subject) return undefined;

  const normalized = subject
    .replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function isForwardLikeEmail(email: ResendReceivedEmail) {
  const subject = email.subject ?? "";
  if (/^\s*(?:fw|fwd)\s*:/i.test(subject)) return true;

  const body = `${email.text ?? ""}\n${email.html ?? ""}`;
  return /forwarded message|begin forwarded message|original message/i.test(body);
}

function isFromInternalSender(email: ResendReceivedEmail, context: SupportEmailContext) {
  const sender = normalizeEmailAddress(email.from ?? "");
  return sender !== undefined && isInternalEmailAddress(sender, context);
}

function supportEmailConversationExternalIds(
  email: ResendReceivedEmail,
  context: SupportEmailContext,
) {
  const subject = normalizedConversationSubject(email);
  if (subject === undefined) return [];

  return externalParticipantAddresses(email, context).map(
    (address) => `conversation:${address}:${subject}`,
  );
}

function normalizeMessageId(value: string) {
  return value.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
}

function messageIdExternalId(messageId: string) {
  return `message:${normalizeMessageId(messageId)}`;
}

function messageIdsFromHeader(value: string | undefined) {
  if (value === undefined) return [];

  const ids = new Set<string>();
  for (const match of value.matchAll(/<([^>]+)>/g)) {
    const normalized = normalizeMessageId(match[1] ?? "");
    if (normalized.length > 0) ids.add(messageIdExternalId(normalized));
  }

  if (ids.size === 0) {
    for (const part of value.split(/\s+/)) {
      const normalized = normalizeMessageId(part);
      if (normalized.includes("@")) ids.add(messageIdExternalId(normalized));
    }
  }

  return [...ids];
}

function legacyMessageIdExternalIds(value: string | undefined) {
  if (value === undefined) return [];

  const ids = new Set<string>();
  const trimmed = value.trim();
  if (trimmed.length > 0) ids.add(trimmed);

  for (const match of value.matchAll(/<([^>]+)>/g)) {
    const full = match[0]?.trim();
    const inner = match[1]?.trim();
    if (full && full.length > 0) ids.add(full);
    if (inner && inner.length > 0) ids.add(inner);
  }

  return [...ids];
}

function previousServerMessageIdExternalIds(value: string | undefined) {
  return legacyMessageIdExternalIds(value).map((id) => `message-id:${id}`);
}

function supportEmailOwnExternalIds(email: ResendReceivedEmail) {
  const ids = new Set<string>();
  const messageId = email.message_id ?? emailHeaderValue(email, "message-id");
  if (messageId !== undefined) {
    for (const id of messageIdsFromHeader(messageId)) {
      ids.add(id);
    }
    for (const id of legacyMessageIdExternalIds(messageId)) {
      ids.add(id);
    }
    for (const id of previousServerMessageIdExternalIds(messageId)) {
      ids.add(id);
    }
  }
  ids.add(`resend:${email.id}`);
  return [...ids];
}

export function supportEmailStoredExternalIds(
  email: ResendReceivedEmail,
  context: SupportEmailContext,
) {
  return [
    ...new Set([
      ...supportEmailOwnExternalIds(email),
      ...supportEmailConversationExternalIds(email, context),
    ]),
  ];
}

export function supportEmailReferencedExternalIds(email: ResendReceivedEmail) {
  const ids = new Set<string>();
  for (const headerName of ["in-reply-to", "references"]) {
    const header = emailHeaderValue(email, headerName);
    for (const id of messageIdsFromHeader(header)) {
      ids.add(id);
    }
    for (const id of legacyMessageIdExternalIds(header)) {
      ids.add(id);
    }
    for (const id of previousServerMessageIdExternalIds(header)) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function supportEmailLookupExternalIds(
  email: ResendReceivedEmail,
  context: SupportEmailContext,
) {
  return [
    ...new Set([
      ...supportEmailReferencedExternalIds(email),
      ...supportEmailOwnExternalIds(email),
      ...(isFromInternalSender(email, context) && isForwardLikeEmail(email)
        ? supportEmailConversationExternalIds(email, context)
        : []),
    ]),
  ];
}

export function supportEmailPrimaryExternalId(
  email: ResendReceivedEmail,
  context: SupportEmailContext,
) {
  return supportEmailStoredExternalIds(email, context)[0] ?? `resend:${email.id}`;
}

function attachmentLines(attachments: readonly ProcessedSupportEmailAttachment[]) {
  if (attachments.length === 0) return [];

  return [
    "",
    "Attachments:",
    ...attachments.map((attachment) => {
      const type = attachment.mimeType?.trim();
      if (attachment.kind === "failed") {
        return type
          ? `- ${attachment.name} (${type}): failed to download (${attachment.error})`
          : `- ${attachment.name}: failed to download (${attachment.error})`;
      }

      const size = Number.isFinite(attachment.sizeBytes) ? `, ${attachment.sizeBytes} bytes` : "";
      return type
        ? `- ${attachment.name} (${type}${size}): ${attachment.localPath}`
        : `- ${attachment.name}${size}: ${attachment.localPath}`;
    }),
  ];
}

export function formatSupportEmailForAgent(
  email: ResendReceivedEmail,
  attachments: readonly ProcessedSupportEmailAttachment[] = [],
  context: SupportEmailContext = {},
) {
  return [
    `From: ${email.from ?? "(unknown sender)"}`,
    `To: ${(email.to ?? [context.groupAddress ?? "(unknown recipient)"]).join(", ")}`,
    ...(email.cc !== undefined && email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    ...(email.created_at !== undefined ? [`Date: ${email.created_at}`] : []),
    `Subject: ${email.subject ?? "(no subject)"}`,
    "",
    emailBody(email),
    ...attachmentLines(attachments),
  ].join("\n");
}

export function supportEmailTitle(email: ResendReceivedEmail) {
  const subject = email.subject?.trim();
  return subject && subject.length > 0 ? `Support: ${subject}` : "Support email triage";
}

export function supportEmailSlackTitle(email: ResendReceivedEmail) {
  const sender = normalizeEmailAddress(email.from ?? "") ?? email.from?.trim() ?? "unknown sender";
  return `New support email from ${sender}: ${email.subject ?? "(no subject)"}`;
}

function shouldCutAtForwardHeader(lines: readonly string[], index: number) {
  const line = lines[index]?.trim() ?? "";
  if (!/^from:\s+/i.test(line)) return false;
  const window = lines.slice(index, index + 8).join("\n");
  return /\n(?:sent|date|to|subject):\s+/i.test(window);
}

export function stripQuotedEmailChain(body: string) {
  const lines = body.split(/\r?\n/);
  let lastMeaningfulLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const hasPriorBody = lastMeaningfulLine >= 0;
    const quoteMarker =
      /^on .+ wrote:$/i.test(trimmed) ||
      /^[-_ ]*original message[-_ ]*$/i.test(trimmed) ||
      /^[-_ ]*forwarded message[-_ ]*$/i.test(trimmed) ||
      /^begin forwarded message:?$/i.test(trimmed) ||
      (trimmed.startsWith(">") && hasPriorBody) ||
      (hasPriorBody && shouldCutAtForwardHeader(lines, index));

    if (quoteMarker && hasPriorBody) {
      return lines.slice(0, index).join("\n").trim();
    }

    if (trimmed.length > 0 && !trimmed.startsWith(">")) {
      lastMeaningfulLine = index;
    }
  }

  return body.trim();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function slackAttachmentSummary(attachments: readonly ProcessedSupportEmailAttachment[]) {
  if (attachments.length === 0) return [];
  const visible = attachments.slice(0, 5).map((attachment) => {
    const type = attachment.mimeType?.trim();
    if (attachment.kind === "failed") {
      return type
        ? `- ${attachment.name} (${type}): failed to download`
        : `- ${attachment.name}: failed to download`;
    }
    return type
      ? `- ${attachment.name} (${type}, ${formatBytes(attachment.sizeBytes)})`
      : `- ${attachment.name} (${formatBytes(attachment.sizeBytes)})`;
  });
  const remaining = attachments.length - visible.length;
  return ["", "Attachments:", ...visible, ...(remaining > 0 ? [`- and ${remaining} more`] : [])];
}

export function supportEmailSlackPreview(input: {
  readonly email: ResendReceivedEmail;
  readonly attachments?: readonly ProcessedSupportEmailAttachment[] | undefined;
  readonly context?: SupportEmailContext | undefined;
}) {
  const email = input.email;
  const body = stripQuotedEmailChain(emailBody(email));
  const preview = [
    `From: ${email.from ?? "(unknown sender)"}`,
    `To: ${(email.to ?? [input.context?.groupAddress ?? "(unknown recipient)"]).join(", ")}`,
    ...(email.cc !== undefined && email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    ...(email.created_at !== undefined ? [`Date: ${email.created_at}`] : []),
    `Subject: ${email.subject ?? "(no subject)"}`,
    "",
    body,
    ...slackAttachmentSummary(input.attachments ?? []),
  ].join("\n");
  return truncateText(preview, SLACK_PREVIEW_MAX_CHARS);
}

function safePathSegment(value: string | undefined, fallback: string) {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[/\\:*?"<>|]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return sanitized.length > 0 && sanitized !== "." && sanitized !== ".." ? sanitized : fallback;
}

async function fetchJson(input: { readonly url: string; readonly apiKey: string }) {
  const response = await fetch(input.url, {
    headers: { authorization: `Bearer ${input.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as unknown;
}

function unwrapResendData(body: unknown) {
  if (body !== null && typeof body === "object" && "data" in body) {
    return (body as { readonly data?: unknown }).data;
  }
  return body;
}

export async function fetchResendReceivedEmail(input: {
  readonly emailId: string;
  readonly apiKey: string;
}) {
  const body = await fetchJson({
    url: `${RESEND_API_BASE_URL}/emails/receiving/${encodeURIComponent(input.emailId)}`,
    apiKey: input.apiKey,
  });
  const email = unwrapResendData(body);
  if (
    email === null ||
    typeof email !== "object" ||
    typeof (email as { readonly id?: unknown }).id !== "string"
  ) {
    throw new Error("Resend received email response did not include an email id.");
  }
  return email as ResendReceivedEmail;
}

async function fetchResendReceivedEmailAttachment(input: {
  readonly emailId: string;
  readonly attachmentId: string;
  readonly apiKey: string;
}) {
  const body = await fetchJson({
    url: `${RESEND_API_BASE_URL}/emails/receiving/${encodeURIComponent(input.emailId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
    apiKey: input.apiKey,
  });
  const attachment = unwrapResendData(body);
  if (
    attachment === null ||
    typeof attachment !== "object" ||
    typeof (attachment as { readonly download_url?: unknown }).download_url !== "string"
  ) {
    throw new Error("Resend attachment response did not include download_url.");
  }
  return attachment as {
    readonly id?: string;
    readonly filename?: string | null;
    readonly size?: number;
    readonly content_type?: string | null;
    readonly download_url: string;
  };
}

async function downloadAttachmentBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment download failed (${response.status}): ${response.statusText}`);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

function isNativeImageCandidate(input: {
  readonly mimeType: string | undefined;
  readonly sizeBytes: number;
}) {
  return (
    input.mimeType?.toLowerCase().startsWith("image/") === true &&
    input.sizeBytes > 0 &&
    input.sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  );
}

export function processSupportEmailAttachments(input: {
  readonly email: ResendReceivedEmail;
  readonly apiKey: string;
  readonly storageDir: string;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachments: ProcessedSupportEmailAttachment[] = [];
    let nativeImageCount = 0;

    for (const [index, attachment] of (input.email.attachments ?? []).entries()) {
      const attachmentId = attachment.id?.trim();
      if (!attachmentId) continue;

      const name =
        attachment.filename?.trim() || attachment.content_id?.trim() || `Attachment ${index + 1}`;
      const fallbackMimeType = attachment.content_type?.trim() || undefined;

      const processed = yield* Effect.gen(function* () {
        const detail = yield* Effect.tryPromise(() =>
          fetchResendReceivedEmailAttachment({
            emailId: input.email.id,
            attachmentId,
            apiKey: input.apiKey,
          }),
        );
        const downloaded = yield* Effect.tryPromise(() =>
          downloadAttachmentBytes(detail.download_url),
        );
        const mimeType =
          detail.content_type?.trim() || downloaded.contentType?.trim() || fallbackMimeType;
        const storedName = detail.filename?.trim() || name;
        const emailDir = path.join(input.storageDir, safePathSegment(input.email.id, "email"));
        const localPath = path.join(
          emailDir,
          `${String(index + 1).padStart(2, "0")}-${safePathSegment(storedName, "attachment")}`,
        );
        yield* fileSystem.makeDirectory(emailDir, { recursive: true });
        yield* fileSystem.writeFile(localPath, downloaded.bytes);

        const includeNativeImage =
          nativeImageCount < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
          isNativeImageCandidate({ mimeType, sizeBytes: downloaded.bytes.byteLength });
        if (includeNativeImage) nativeImageCount += 1;

        return {
          kind: "stored" as const,
          id: attachmentId,
          name: storedName,
          ...(mimeType !== undefined ? { mimeType } : {}),
          sizeBytes: downloaded.bytes.byteLength,
          localPath,
          ...(includeNativeImage
            ? {
                nativeImageDataUrl: `data:${mimeType};base64,${downloaded.bytes.toString("base64")}`,
              }
            : {}),
        } satisfies ProcessedSupportEmailAttachment;
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.succeed({
            kind: "failed" as const,
            id: attachmentId,
            name,
            ...(fallbackMimeType !== undefined ? { mimeType: fallbackMimeType } : {}),
            error: errorSummary(error),
          } satisfies ProcessedSupportEmailAttachment),
        ),
      );

      attachments.push(processed);
    }

    return attachments;
  });
}

export function supportEmailUploadAttachments(
  attachments: readonly ProcessedSupportEmailAttachment[],
): UploadChatAttachment[] {
  return attachments.flatMap((attachment) => {
    if (
      attachment.kind !== "stored" ||
      attachment.nativeImageDataUrl === undefined ||
      attachment.mimeType === undefined
    ) {
      return [];
    }
    return [
      {
        type: "image" as const,
        name: attachment.name.slice(0, 255),
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: attachment.nativeImageDataUrl,
      },
    ];
  });
}

export function decodeResendWebhook(payload: ResendReceivedEmailWebhook) {
  if (payload.type !== undefined && payload.type !== "email.received") {
    return { type: "ignored" as const, reason: `ignored_event_type:${String(payload.type)}` };
  }

  const emailId = payload.data?.email_id;
  if (typeof emailId !== "string" || emailId.trim().length === 0) {
    return { type: "ignored" as const, reason: "missing_email_id" };
  }

  return { type: "email.received" as const, emailId };
}
