import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ExternalIntake, type ExternalSlackNotificationLink } from "./ExternalIntake.ts";
import { ExternalChat } from "./ExternalChat.ts";
import { isSlackChatSdkConfigured } from "./chatSdkAdapters.ts";
import { parseGitHubPullRequestMergedEvent } from "./github.ts";
import { loadIntakeProfiles, type IntakeProjectProfile } from "./profiles.ts";
import { slackThreadUrl, t3ThreadUrl } from "./slack.ts";
import { ExternalIntegrationRepository } from "../persistence/Services/ExternalIntegrations.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

interface ResendReceivedEmailWebhook {
  readonly type?: unknown;
  readonly data?: {
    readonly email_id?: unknown;
  };
}

interface ResendReceivedEmail {
  readonly id: string;
  readonly to?: readonly string[];
  readonly from?: string;
  readonly created_at?: string;
  readonly subject?: string | null;
  readonly html?: string | null;
  readonly text?: string | null;
  readonly headers?: Record<string, string>;
  readonly message_id?: string | null;
  readonly attachments?: ReadonlyArray<{
    readonly id?: string;
    readonly filename?: string | null;
    readonly content_type?: string | null;
  }>;
}

class ExternalIntakeHttpError extends Data.TaggedError("ExternalIntakeHttpError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requiredEnv(name: string) {
  const value = envValue(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function json(body: unknown, init: ResponseInit = {}) {
  return HttpServerResponse.jsonUnsafe(body, init);
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function mapUnknownToHttpError(error: unknown) {
  return new ExternalIntakeHttpError({ message: errorMessage(error), cause: error });
}

function trySync<A>(evaluate: () => A) {
  return Effect.try({ try: evaluate, catch: mapUnknownToHttpError });
}

function webRequestFromServerRequest(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly rawBody: string;
}) {
  const url = HttpServerRequest.toURL(input.request);
  if (Option.isNone(url)) {
    throw new ExternalIntakeHttpError({
      message: "Unable to resolve request URL.",
      cause: null,
    });
  }

  return new Request(url.value.toString(), {
    method: input.request.method,
    headers: input.request.headers,
    body: input.rawBody,
  });
}

function optionCreatedAt<T extends { readonly createdAt: string }>(
  option: Option.Option<T>,
  fallback: string,
) {
  return Option.getOrElse(
    Option.map(option, (value) => value.createdAt),
    () => fallback,
  );
}

function timingSafeEqualString(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function verifyGitHubWebhookSignature(input: {
  readonly body: string;
  readonly signature: string | null;
}) {
  const secret = envValue("GITHUB_WEBHOOK_SECRET");
  if (secret === undefined) {
    return;
  }
  if (input.signature === null || !input.signature.startsWith("sha256=")) {
    throw new Error("Missing GitHub webhook signature.");
  }
  const expected = `sha256=${createHmac("sha256", secret).update(input.body).digest("hex")}`;
  if (!timingSafeEqualString(input.signature, expected)) {
    throw new Error("Invalid GitHub webhook signature.");
  }
}

function secretBytes(secret: string) {
  return Buffer.from(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
    "base64",
  );
}

function verifyResendWebhookSignature(input: {
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}) {
  const secret = envValue("RESEND_WEBHOOK_SECRET");
  if (secret === undefined) {
    return;
  }
  const id = input.headers["svix-id"];
  const timestamp = input.headers["svix-timestamp"];
  const signatureHeader = input.headers["svix-signature"];
  if (id === undefined || timestamp === undefined || signatureHeader === undefined) {
    throw new Error("Missing Resend webhook signature headers.");
  }
  const expected = createHmac("sha256", secretBytes(secret))
    .update(`${id}.${timestamp}.${input.body}`)
    .digest();
  const signatures = signatureHeader
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [version, signature] = part.split(",");
      return version === "v1" && signature ? [signature] : [];
    });
  for (const signature of signatures) {
    const actual = Buffer.from(signature, "base64");
    if (actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)) {
      return;
    }
  }
  throw new Error("Invalid Resend webhook signature.");
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function parseJsonEffect<T>(raw: string) {
  return trySync(() => parseJson<T>(raw));
}

function supportEmailExternalIds(email: ResendReceivedEmail) {
  const ids = new Set<string>();
  ids.add(`resend:${email.id}`);
  if (email.message_id !== undefined && email.message_id !== null) {
    ids.add(`message-id:${email.message_id}`);
  }
  const inReplyTo = email.headers?.["In-Reply-To"] ?? email.headers?.["in-reply-to"];
  if (inReplyTo !== undefined && inReplyTo.trim().length > 0) {
    ids.add(`message-id:${inReplyTo.trim()}`);
  }
  const references = email.headers?.References ?? email.headers?.references;
  for (const reference of references?.matchAll(/<[^>]+>/g) ?? []) {
    ids.add(`message-id:${reference[0]}`);
  }
  return [...ids];
}

function formattedEmail(email: ResendReceivedEmail) {
  const attachmentLines =
    email.attachments?.flatMap((attachment) =>
      attachment.filename
        ? [
            `- ${attachment.filename}${attachment.content_type ? ` (${attachment.content_type})` : ""}`,
          ]
        : [],
    ) ?? [];
  return [
    `From: ${email.from ?? "unknown"}`,
    `To: ${email.to?.join(", ") ?? "unknown"}`,
    `Subject: ${email.subject ?? "(no subject)"}`,
    "",
    email.text ?? email.html ?? "",
    ...(attachmentLines.length > 0 ? ["", "Attachments:", ...attachmentLines] : []),
  ].join("\n");
}

function profileMatchesEmail(profile: IntakeProjectProfile, email: ResendReceivedEmail) {
  const configured = profile.supportEmail?.to ?? [];
  if (configured.length === 0) return profile.supportEmail !== undefined;
  const recipients = new Set((email.to ?? []).map((value) => value.toLowerCase()));
  return configured.some((address) => recipients.has(address.toLowerCase()));
}

async function fetchResendEmail(emailId: string): Promise<ResendReceivedEmail> {
  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, {
    headers: { authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}` },
  });
  if (!response.ok) {
    throw new Error(`Resend email fetch failed: ${response.status} ${response.statusText}`);
  }
  const parsed = (await response.json()) as ResendReceivedEmail;
  if (typeof parsed.id !== "string") {
    throw new Error("Resend email response was missing id.");
  }
  return parsed;
}

export const slackWebhookRouteLayer = HttpRouter.add(
  "POST",
  "/slack/webhook",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.text;
    const externalChat = yield* ExternalChat;
    const response = yield* externalChat.handleSlackWebhook(
      webRequestFromServerRequest({ request, rawBody }),
    );
    return HttpServerResponse.fromWeb(response);
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.succeed(json({ error: errorMessage(error) }, { status: 500 })),
    ),
  ),
);

export const supportEmailWebhookRouteLayer = HttpRouter.add(
  "POST",
  "/support-email/resend",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.text;
    yield* trySync(() => verifyResendWebhookSignature({ body: rawBody, headers: request.headers }));
    const payload = yield* parseJsonEffect<ResendReceivedEmailWebhook>(rawBody);
    const emailId = payload.data?.email_id;
    if (typeof emailId !== "string" || emailId.trim().length === 0) {
      return json({ accepted: true, ignored: true, reason: "missing_email_id" });
    }

    const repository = yield* ExternalIntegrationRepository;
    const intake = yield* ExternalIntake;
    const externalChat = yield* ExternalChat;
    const existingReceipt = yield* repository.getEventReceipt({
      source: "support_email",
      eventId: emailId,
    });
    if (Option.isSome(existingReceipt) && existingReceipt.value.status === "completed") {
      return json({ accepted: true, duplicate: true });
    }

    const now = DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe()));
    yield* repository.upsertEventReceipt({
      source: "support_email",
      eventId: emailId,
      status: "processing",
      metadata: {},
      createdAt: optionCreatedAt(existingReceipt, now),
      updatedAt: now,
    });

    const email = yield* Effect.promise(() => fetchResendEmail(emailId));
    const profiles = loadIntakeProfiles();
    const profile = profiles.find((candidate) => profileMatchesEmail(candidate, email));
    if (profile === undefined) {
      return yield* new ExternalIntakeHttpError({
        message:
          "No support email intake profile matched this email. Configure T3_INTAKE_PROFILES_JSON or SUPPORT_EMAIL_PROJECT_WORKSPACE_ROOT.",
        cause: null,
      });
    }

    const supportExternalIds = supportEmailExternalIds(email);
    for (const supportExternalId of supportExternalIds) {
      const existingLink = yield* repository.getThreadLink({
        source: "support_email",
        externalThreadId: supportExternalId,
      });
      if (Option.isSome(existingLink)) {
        return json({ accepted: true, duplicate: true, t3ThreadId: existingLink.value.t3ThreadId });
      }
    }

    let notificationSlackLink: ExternalSlackNotificationLink | undefined;
    const slackChannelId = profile.supportEmail?.slackChannelId;
    if (slackChannelId !== undefined) {
      const posted = yield* externalChat.postToChannel({
        source: "slack",
        channelId: slackChannelId,
        text: `Support email received: ${email.subject ?? "(no subject)"}\nFrom: ${email.from ?? "unknown"}`,
      });
      notificationSlackLink = {
        externalThreadId: posted.externalThreadId,
        channelId: posted.channelId,
        threadTs: posted.threadTs,
        primaryExternalMessageId: posted.externalMessageId,
        url: slackThreadUrl({ channelId: posted.channelId, threadTs: posted.threadTs }),
      };
    }

    const primaryExternalId = supportExternalIds[0] ?? `resend:${email.id}`;
    const result = yield* intake.handleMessage({
      source: "support_email",
      externalThreadId: primaryExternalId,
      externalMessageId: `support-email:${email.id}`,
      text: formattedEmail(email),
      title: email.subject?.trim() || "Support email",
      receivedAt: email.created_at ?? now,
      profile,
      url: notificationSlackLink?.url,
      ...(notificationSlackLink !== undefined ? { notificationSlackLink } : {}),
    });

    if (result.status === "created") {
      for (const supportExternalId of supportExternalIds.slice(1)) {
        yield* repository.upsertThreadLink({
          source: "support_email",
          externalThreadId: supportExternalId,
          t3ThreadId: result.t3ThreadId,
          projectId: result.projectId,
          primaryExternalMessageId: `support-email:${email.id}`,
          url: notificationSlackLink?.url ?? null,
          muted: false,
          metadata: { emailId: email.id },
          createdAt: now,
          updatedAt: now,
        });
      }
      if (notificationSlackLink !== undefined) {
        const threadUrl = t3ThreadUrl({
          baseUrl: envValue("T3_WEB_APP_BASE_URL") ?? envValue("T3CODE_PUBLIC_BASE_URL"),
          environmentId: result.environmentId,
          t3ThreadId: String(result.t3ThreadId),
        });
        if (threadUrl !== undefined) {
          yield* externalChat
            .postToThread({
              source: "slack",
              externalThreadId: notificationSlackLink.externalThreadId,
              text: `Open T3: ${threadUrl}`,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
      }
    }

    const doneAt = DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe()));
    yield* repository.upsertEventReceipt({
      source: "support_email",
      eventId: emailId,
      status: "completed",
      metadata: result,
      createdAt: optionCreatedAt(existingReceipt, now),
      updatedAt: doneAt,
    });
    return json({ accepted: true, result });
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.succeed(json({ error: errorMessage(error) }, { status: 500 })),
    ),
  ),
);

export const githubWebhookRouteLayer = HttpRouter.add(
  "POST",
  "/github/webhook",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.text;
    yield* trySync(() =>
      verifyGitHubWebhookSignature({
        body: rawBody,
        signature: request.headers["x-hub-signature-256"] ?? null,
      }),
    );
    const eventName = request.headers["x-github-event"] ?? "";
    const deliveryId = request.headers["x-github-delivery"] ?? randomUUID();
    const repository = yield* ExternalIntegrationRepository;
    const externalChat = yield* ExternalChat;
    const existingReceipt = yield* repository.getEventReceipt({
      source: "github",
      eventId: deliveryId,
    });
    if (Option.isSome(existingReceipt) && existingReceipt.value.status === "completed") {
      return json({ accepted: true, duplicate: true });
    }
    const now = DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe()));
    const payload = yield* parseJsonEffect<unknown>(rawBody);
    const merged = parseGitHubPullRequestMergedEvent(eventName, payload);
    if (merged === null) {
      return json({ accepted: true, ignored: true, reason: "unsupported_event" });
    }
    const artifact = yield* repository.getArtifactLink({
      kind: "github_pr",
      externalId: merged.externalId,
    });
    if (Option.isNone(artifact)) {
      return json({ accepted: true, ignored: true, reason: "unlinked_pr" });
    }
    const links = yield* repository.listThreadLinksByThread(artifact.value.t3ThreadId);
    let delivered = 0;
    for (const link of links) {
      if (link.source !== "slack" || link.primaryExternalMessageId === null) continue;
      const deliveryKey = `github-pr-merged:${merged.externalId}:${link.externalThreadId}`;
      const delivery = yield* repository.getDeliveryReceipt({ source: "github", deliveryKey });
      if (Option.isSome(delivery) && delivery.value.status === "completed") continue;
      yield* externalChat
        .addReaction({
          source: "slack",
          externalThreadId: link.externalThreadId,
          externalMessageId: link.primaryExternalMessageId,
          name: "white_check_mark",
        })
        .pipe(Effect.ignoreCause({ log: true }));
      const posted = yield* externalChat.postToThread({
        source: "slack",
        externalThreadId: link.externalThreadId,
        text: `PR was merged: ${merged.url}${merged.title ? `\n${merged.title}` : ""}`,
      });
      yield* repository.upsertDeliveryReceipt({
        source: "github",
        deliveryKey,
        status: "completed",
        externalMessageId: posted.externalMessageId,
        metadata: merged,
        createdAt: optionCreatedAt(delivery, now),
        updatedAt: DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe())),
      });
      delivered += 1;
    }
    yield* repository.upsertEventReceipt({
      source: "github",
      eventId: deliveryId,
      status: "completed",
      metadata: { merged, delivered },
      createdAt: optionCreatedAt(existingReceipt, now),
      updatedAt: DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe())),
    });
    return json({ accepted: true, delivered });
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.succeed(json({ error: errorMessage(error) }, { status: 500 })),
    ),
  ),
);

export const externalIntakeHealthRouteLayer = HttpRouter.add(
  "GET",
  "/api/external-intake/health",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = HttpServerRequest.toURL(request);
    const baseUrl =
      envValue("T3CODE_PUBLIC_BASE_URL") ??
      (Option.isSome(requestUrl) ? requestUrl.value.origin : "http://127.0.0.1:3773");
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    return json({
      ok: true,
      environment: descriptor,
      chatAdapters: {
        slack: isSlackChatSdkConfigured(),
      },
      slackWebhookUrl: `${baseUrl.replace(/\/$/, "")}/slack/webhook`,
      supportEmailWebhookUrl: `${baseUrl.replace(/\/$/, "")}/support-email/resend`,
      githubWebhookUrl: `${baseUrl.replace(/\/$/, "")}/github/webhook`,
    });
  }),
);
