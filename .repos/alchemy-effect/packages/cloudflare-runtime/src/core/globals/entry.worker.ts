import type {
  ExportedHandler,
  Fetcher,
  Request as WorkersRequest,
} from "@cloudflare/workers-types/experimental";
import PostalMime, { type Email } from "postal-mime";
import { RAW_EMAIL } from "../bindings/send-email/SendEmailOptions.shared.ts";
import { makeErrorResponse } from "../internal/response.shared.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import { HEADER_CF_BLOB } from "./CfOptions.shared.ts";
// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import {
  BINDING_EMAIL_DIRECTORY,
  BINDING_EMAIL_DISK,
  PATH_EMAIL,
  PATH_HANDLER_PREFIX,
} from "./EmailOptions.shared.ts";
import { BINDING_USER_WORKER_DIRECT } from "./EntryOptions.shared.ts";
import {
  PATH_SCHEDULED,
  PATH_SCHEDULED_LEGACY,
} from "./ScheduledOptions.shared.ts";

interface Env {
  /**
   * Head of the fetch middleware chain (the next middleware after the entry,
   * or the raw user worker when no downstream middleware exists). Fetch-only.
   */
  USER_WORKER: Fetcher;
  /**
   * The raw user worker, bypassing downstream fetch middlewares. All
   * non-fetch JSRPC dispatch (`queue()`, `scheduled()`, `email()`) goes
   * through this binding — middlewares are fetch-only HTTP interceptors and
   * do not implement those methods (see EntryOptions.shared.ts).
   */
  [BINDING_USER_WORKER_DIRECT]: Fetcher;
  CF_BLOB: Record<string, unknown>;
  // Omitted when the runtime storage isn't disk-backed (never the case with
  // the built-in storage layers) — replies then fail with a clear error.
  [BINDING_EMAIL_DISK]?: Fetcher;
  [BINDING_EMAIL_DIRECTORY]?: string;
}

export interface EntryQueuePayload {
  queue: string;
  messages: Array<ServiceBindingQueueMessage>;
  metadata?: MessageBatchMetadata;
}

// -----------------------------------------------------------------------------
// Inbound email (`/cdn-cgi/handler/email`), ported from Miniflare's
// `workers/core/email.ts` and `workers/email/validate.ts`. Miniflare logs
// through its loopback log endpoint and persists replies via the loopback
// `store-temp-file` endpoint; here warnings/errors go to the console and
// replies are persisted through the `email:storage` disk service (rooted at
// `{storage}/email`, the same directory the send-email simulator writes to).
// -----------------------------------------------------------------------------

/**
 * The runtime shape of the local `EmailMessage` shim
 * (see `bindings/send-email/EmailMessage.worker.ts`).
 */
interface LocalEmailMessage {
  from: string;
  to: string;
  [RAW_EMAIL]: ReadableStream<Uint8Array>;
}

interface EmailSendResult {
  messageId: string;
}

function renderEmailHeaders(headers: Headers | undefined): string {
  return headers
    ? `\n  headers:\n${[...headers.entries()].map(([k, v]) => `    ${k}: ${v}`).join("\n")}`
    : "";
}

/**
 * Appends path segments to a base path using the separator already implied by
 * the base path string (mirrors `bindings/send-email/SendEmailBinding.worker.ts`).
 */
function joinPath(base: string, ...segments: Array<string>): string {
  const separator = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...segments].join(separator);
}

/**
 * Email Routing has some limits on what emails can be responded to, documented
 * at https://developers.cloudflare.com/email-routing/email-workers/reply-email-workers/
 * (`workers/email/validate.ts` `isEmailReplyable`; the log callback is
 * replaced with a direct `console.error`).
 */
function isEmailReplyable(
  email: Email,
  incomingEmailHeaders: Headers,
): boolean {
  // The x-auto-response-suppress header is set by MS Exchange and some other
  // email services on outgoing email to opt-out of automatic responses. If
  // it's set, don't allow the user Worker to reply to the email
  const autoResponseSuppress = incomingEmailHeaders
    .get("x-auto-response-suppress")
    ?.toLowerCase();
  if (autoResponseSuppress !== undefined && autoResponseSuppress !== "none") {
    return false;
  }

  // The auto-submitted header is set by some services to indicate that the
  // email is auto generated. If it's set, don't allow the user Worker to
  // reply to the email
  const autoSubmittedValue = incomingEmailHeaders
    .get("auto-submitted")
    ?.toLowerCase();
  if (autoSubmittedValue !== undefined && autoSubmittedValue !== "no") {
    return false;
  }

  if (email.inReplyTo === undefined && email.references === undefined) {
    // If this email is _not_ part of an existing reply chain, it can be
    // replied to
    return true;
  } else if (email.inReplyTo !== undefined && email.references !== undefined) {
    // If this email _is_ part of an existing reply chain, we need to validate
    // the References header according to
    // https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4

    // Email Routing does not support more than 100 entries in the References
    // header. Instead of parsing the References header we count the
    // occurrences of the `@` symbol, which occurs once per email
    if ((email.references.match(/@/g)?.length ?? 0) >= 100) {
      console.error(
        'The incoming email\'s "References" header has more than 100 entries. As such, your Worker cannot respond to this email. Refer to https://developers.cloudflare.com/email-routing/email-workers/reply-email-workers/',
      );
      return false;
    }

    return true;
  } else {
    // While this case (one of In-Reply-To or References being empty) is
    // technically allowed by the RFC
    // (https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4), Email
    // Routing does not support replying to emails with this format
    return false;
  }
}

/**
 * Throws if there's anything wrong with the reply (matching the errors
 * production sends). Also adds the `References` header if it's not on the
 * reply email (`workers/email/validate.ts` `validateReply`).
 *
 * @returns Actual email to be used to reply (with all correct headers)
 */
async function validateReply(
  incomingMessage: Email,
  replyMessage: LocalEmailMessage,
): Promise<Uint8Array> {
  const rawEmail: ReadableStream<Uint8Array> = replyMessage[RAW_EMAIL];

  const rawEmailBuffer = new Uint8Array(
    await new Response(rawEmail).arrayBuffer(),
  );

  let parsedReply: Email;
  try {
    parsedReply = await PostalMime.parse(rawEmailBuffer);
  } catch (e) {
    const error = e as Error;
    throw new Error(`could not parse email: ${error.message}`, { cause: e });
  }

  if (parsedReply.from?.address !== replyMessage.from) {
    throw new Error("From: header does not match mail from");
  }

  if (parsedReply.messageId === undefined) {
    throw new Error("invalid message-id");
  }

  const replyEmailHeaders = new Headers(
    parsedReply.headers.map((header) => [header.key, header.value]),
  );

  // Replies from an Email Worker cannot change the Received header
  if (replyEmailHeaders.get("received") !== null) {
    throw new Error("invalid headers set");
  }

  if (parsedReply.inReplyTo === undefined) {
    throw new Error("no In-Reply-To header found in reply message");
  }

  if (parsedReply.inReplyTo !== incomingMessage.messageId) {
    throw new Error("In-Reply-To does not match original Message-ID");
  }

  const incomingReferences = incomingMessage.references ?? "";

  if (parsedReply.references !== undefined) {
    // if the email has the References header, we just validate it matches the
    // incoming References header and also includes the incoming message ID.
    // Refer to https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4
    if (
      !(
        parsedReply.references.includes(incomingMessage.messageId) &&
        parsedReply.references.includes(incomingReferences)
      )
    ) {
      throw new Error("provided References header is invalid");
    }
  } else {
    // Otherwise, we need to construct a new References header according to
    // https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4
    const replyReferences = `References: ${incomingMessage.messageId}${
      incomingReferences.length > 0 ? " " : ""
    }${incomingReferences}\r\n`;

    const encodedReferences = new TextEncoder().encode(replyReferences);

    const finalReplyEmail = new Uint8Array(
      encodedReferences.byteLength + rawEmailBuffer.byteLength,
    );

    // prepend References to be in the headers instead of the end of the body
    finalReplyEmail.set(encodedReferences, 0);
    finalReplyEmail.set(rawEmailBuffer, encodedReferences.byteLength);
    return finalReplyEmail;
  }

  return rawEmailBuffer;
}

/**
 * The message ID in production is a random string that identifies the message
 * for e.g. linking up threads. In production it uses the sender domain rather
 * than example.com. Locally, we have access to none of that information so
 * instead we make a dummy message ID that matches the production format
 * (mirrors `workers/core/email.ts`).
 */
function synthesizeLocalMessageId(): string {
  const uuid = crypto.randomUUID().replaceAll("-", "");
  return `${uuid}@example.com`;
}

/**
 * Turn an HTTP request into a `ForwardableEmailMessage`-like object and
 * dispatch it to the user worker's `email()` handler
 * (`workers/core/email.ts` `handleEmail`), using:
 * - `from` and `to` from the URL — the SMTP envelope addresses
 *   (https://datatracker.ietf.org/doc/html/rfc5321#section-3)
 * - `raw` from the request body
 * - `headers` from the parsed message headers
 */
async function handleEmail(
  params: URLSearchParams,
  request: WorkersRequest,
  env: Env,
): Promise<Response> {
  const from = params.get("from");
  const to = params.get("to");

  if (!request.body || !from || !to) {
    return new Response(
      "Invalid email. Your request must include URL parameters specifying the `from` and `to` addresses, as well as an email in the body",
      { status: 400 },
    );
  }
  // We need to parse the email body in this handler in order to validate it,
  // but we also want to pass through the raw email to the user Worker. As
  // such, clone the request for use in this handler.
  const clonedRequest = request.clone();
  const rawBody = clonedRequest.body;
  if (rawBody === null) {
    return new Response("Cloned request body is null", { status: 500 });
  }

  const incomingEmailRaw = new Uint8Array(await request.arrayBuffer());

  // Email Routing does not support messages bigger than 25MiB:
  // https://developers.cloudflare.com/email-routing/limits/#message-size
  // In practice, local dev only supports 1MB, since it uses a JSRPC transport.
  if (incomingEmailRaw.byteLength > 25 * 1024 * 1024) {
    return new Response(
      "Email message size is bigger than the production size limit of 25MiB. Local development has a lower limit of 1Mib.",
      { status: 400 },
    );
  }
  if (incomingEmailRaw.byteLength > 1024 * 1024) {
    return new Response(
      "Email message size is within the production size limit of 25MiB, but exceeds the lower 1Mib limit for testing locally.",
      { status: 400 },
    );
  }

  let parsedIncomingEmail: Email;
  try {
    parsedIncomingEmail = await PostalMime.parse(incomingEmailRaw);
  } catch (e) {
    const error = e as Error;
    return new Response(
      `Email could not be parsed: ${error.name}: ${error.message}`,
      {
        status: 400,
      },
    );
  }

  if (parsedIncomingEmail.messageId === undefined) {
    return new Response(
      "Email could not be parsed: invalid or no message id provided",
      {
        status: 400,
      },
    );
  }

  // Emails can contain both an "envelope" from/to and a "header" from/to.
  // Warn if these are different. Refer to
  // https://datatracker.ietf.org/doc/html/rfc5321#section-3,
  // https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.2, and
  // https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.3
  if (from !== parsedIncomingEmail.from?.address) {
    console.warn(
      `Provided MAIL FROM address doesn't match the email message's "From" header:\n  MAIL FROM: ${from}\n  "From" header: ${parsedIncomingEmail.from?.address}`,
    );
  }

  if (!parsedIncomingEmail.to?.map((addr) => addr.address).includes(to)) {
    console.warn(
      `Provided RCPT TO address doesn't match any "To" header in the email message:\n  RCPT TO: ${to}\n  "To" header: ${parsedIncomingEmail.to?.map((addr) => addr.address).join(", ")}`,
    );
  }

  const incomingEmailHeaders = new Headers(
    parsedIncomingEmail.headers.map((header) => [header.key, header.value]),
  );

  // Propagate `.setReject()` reasons to the caller
  let maybeClientError: string | undefined = undefined;

  // Construct a ForwardableEmailMessage-like object. We need
  // - it to be able to be passed across JSRPC (to support e.g.
  //   userWorker.email(message))
  // - its properties to be synchronously available (to match production),
  //   which rules out a class extending `RpcStub`
  // Unlike EmailMessage (see EmailMessage.worker.ts) it doesn't need to be
  // user-constructable, so a plain object suffices.
  const message = {
    from,
    to,
    raw: rawBody,
    rawSize: incomingEmailRaw.byteLength,
    headers: incomingEmailHeaders,
    setReject: (reason: string): void => {
      console.error(
        `Email handler rejected message with the following reason: "${reason}"`,
      );
      maybeClientError = reason;
    },
    forward: async (
      rcptTo: string,
      headers?: Headers,
    ): Promise<EmailSendResult> => {
      console.log(
        `Email handler forwarded message with\n  rcptTo: ${rcptTo}${renderEmailHeaders(headers)}`,
      );
      return { messageId: synthesizeLocalMessageId() };
    },
    reply: async (
      replyMessage: LocalEmailMessage,
    ): Promise<EmailSendResult> => {
      if (!isEmailReplyable(parsedIncomingEmail, incomingEmailHeaders)) {
        throw new Error("Original email is not replyable");
      }
      const finalReply = await validateReply(parsedIncomingEmail, replyMessage);

      const disk = env[BINDING_EMAIL_DISK];
      const directory = env[BINDING_EMAIL_DIRECTORY];
      if (disk === undefined || directory === undefined) {
        throw new Error(
          "Cannot persist the email reply: the runtime storage has no disk path.",
        );
      }
      const fileName = `${crypto.randomUUID()}.eml`;
      await disk.fetch(new URL(fileName, "http://placeholder/").toString(), {
        method: "PUT",
        body: finalReply,
      });
      const file = joinPath(directory, fileName);

      console.log(
        `Email handler replied to sender with the following message:\n  ${file}`,
      );

      return { messageId: synthesizeLocalMessageId() };
    },
  };

  // `email` is not on the `Fetcher` type, but service bindings expose the
  // user worker's `email()` handler as a valid JSRPC call (Miniflare relies
  // on the same mechanism).
  await (
    env[BINDING_USER_WORKER_DIRECT] as unknown as {
      email: (message: unknown) => Promise<void>;
    }
  ).email(message);

  if (maybeClientError !== undefined) {
    return new Response(
      `Worker rejected email with the following reason: ${maybeClientError}`,
      {
        status: 400,
      },
    );
  }

  return new Response("Worker successfully processed email", { status: 200 });
}

export default <ExportedHandler<Env>>{
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/cdn-cgi/handler/queue") {
      try {
        const json = await request.json<EntryQueuePayload>();
        const result = await env[BINDING_USER_WORKER_DIRECT].queue(
          json.queue,
          json.messages.map((message) => ({
            ...message,
            timestamp: new Date(message.timestamp),
          })),
          json.metadata,
        );
        return Response.json({ ok: true, result });
      } catch (error) {
        return makeErrorResponse(
          new SystemError({
            subtag: "UserQueueHandler",
            message: `User worker's queue handler threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
            cause: error,
          }),
        );
      }
    }
    // Trigger the user worker's `scheduled()` handler, mirroring Miniflare's
    // `/cdn-cgi/handler/scheduled` route (`workers/core/scheduled.ts`).
    // Like the queue route above, this is always on: the entry socket only
    // binds 127.0.0.1 during local development, so there is no equivalent of
    // Miniflare's `unsafeTriggerHandlers` gate.
    if (
      url.pathname === PATH_SCHEDULED ||
      url.pathname === PATH_SCHEDULED_LEGACY
    ) {
      try {
        const time = url.searchParams.get("time");
        const result = await env[BINDING_USER_WORKER_DIRECT].scheduled({
          scheduledTime: time ? new Date(parseInt(time)) : undefined,
          cron: url.searchParams.get("cron") ?? undefined,
        });
        if (url.searchParams.get("format") === "json") {
          return Response.json(result, {
            status: result.outcome === "ok" ? 200 : 500,
          });
        }
        return new Response(result.outcome, {
          status: result.outcome === "ok" ? 200 : 500,
        });
      } catch (error) {
        return makeErrorResponse(
          new SystemError({
            subtag: "UserScheduledHandler",
            message: `User worker's scheduled handler threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
            cause: error,
          }),
        );
      }
    }
    // Dispatch an inbound email to the user worker's `email()` handler,
    // mirroring Miniflare's `/cdn-cgi/handler/email` route
    // (`workers/core/email.ts`). Like the scheduled route above, this is
    // always on. Errors thrown by the user's handler (including reply
    // validation failures propagated back over JSRPC) surface as a 500 with
    // the error stack, matching Miniflare's entry worker catch-all.
    if (url.pathname === PATH_EMAIL) {
      try {
        return await handleEmail(
          url.searchParams,
          request as unknown as WorkersRequest,
          env,
        );
      } catch (e) {
        return new Response((e as Error | undefined)?.stack ?? String(e), {
          status: 500,
        });
      }
    }
    // Unknown trigger-handler paths get a 404 pointing at the valid handlers
    // (mirrors Miniflare's entry worker; the queue route above is internal
    // and deliberately left out of the hint).
    if (url.pathname.startsWith(PATH_HANDLER_PREFIX)) {
      return new Response(
        `"${url.pathname}" is not a valid handler. Did you mean to use "${PATH_SCHEDULED}" or "${PATH_EMAIL}"?`,
        { status: 404 },
      );
    }
    // Build the user worker's `request.cf` (mirrors Miniflare's
    // `workers/core/entry.worker.ts`): the `MF-CF-Blob` header wins if
    // present, otherwise the configured blob is used, preserving the client's
    // `Accept-Encoding` (defaulting to empty string so `undefined` survives
    // proxying).
    //
    // The blob is parsed here rather than via workerd's `cfBlobHeader` socket
    // option because workerd only provides `request.cf.clientIp` when no
    // `cfBlobHeader` is configured.
    const clientIp = request.cf?.clientIp as string | undefined;
    const clientCfBlobHeader = request.headers.get(HEADER_CF_BLOB);
    const cf: Record<string, unknown> = clientCfBlobHeader
      ? JSON.parse(clientCfBlobHeader)
      : {
          ...env.CF_BLOB,
          clientAcceptEncoding: request.headers.get("Accept-Encoding") ?? "",
        };

    const headers = new Headers(request.headers);
    headers.delete(HEADER_CF_BLOB);
    if (clientIp && !headers.get("CF-Connecting-IP")) {
      // `clientIp` includes the port, e.g. `127.0.0.1:52621` or `[::1]:52621`
      const ipv4Regex = /(?<ip>.*?):\d+/;
      const ipv6Regex = /\[(?<ip>.*?)\]:\d+/;
      const ip =
        clientIp.match(ipv6Regex)?.groups?.ip ??
        clientIp.match(ipv4Regex)?.groups?.ip;
      if (ip) {
        headers.set("CF-Connecting-IP", ip);
      }
    }

    // The experimental and standard workers-types `Request` generics
    // disagree; at runtime these are the same class.
    const userRequest = new Request(request as unknown as Request, {
      headers,
      cf,
    });
    return await env.USER_WORKER.fetch(
      userRequest as unknown as typeof request,
    );
  },
};
