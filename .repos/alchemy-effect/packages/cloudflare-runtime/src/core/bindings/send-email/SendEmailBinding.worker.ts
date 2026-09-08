// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local `send_email` binding simulator, adapted from Miniflare's email plugin
 * worker (`workers-sdk/packages/miniflare/src/workers/email/send_email.worker.ts`).
 *
 * A single `send-email` service hosts every `send_email` binding. The user
 * worker's binding is a service binding targeting the `SendEmailBinding`
 * entrypoint; per-binding address restrictions travel on the service
 * designator props (`ctx.props`), following the one-service-per-binding-type
 * topology used by the other simulators (KV, D1, ...).
 *
 * `send()` validates the sender/recipients against the binding configuration
 * and the MIME message itself (parseable, Message-ID present, `From:` header
 * matching the envelope sender, no `Received:` header), then persists the
 * message through the `send-email:storage` disk service — `.eml` files at the
 * root of `{storage}/email`, MessageBuilder text/html/attachments under
 * `text/`, `html/` and `attachment/` — and logs the absolute file path.
 * (Miniflare writes to `email/`, `email-text/`, `email-html/` and
 * `email-attachment/` under a temporary directory instead; our root is
 * already named `email`, so the redundant prefix is dropped.) Errors and log
 * messages match Miniflare's.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import PostalMime, { type Email } from "postal-mime";
import type { SendEmailServiceProps } from "./SendEmailOptions.shared.ts";
import {
  BINDING_SEND_EMAIL_DIRECTORY,
  BINDING_SEND_EMAIL_DISK,
  RAW_EMAIL,
} from "./SendEmailOptions.shared.ts";

// -----------------------------------------------------------------------------
// Types (`workers/email/types.ts`, `workers/email/email.worker.ts`)
// -----------------------------------------------------------------------------

/** The runtime shape of the local `EmailMessage` shim (see `EmailMessage.worker.ts`). */
interface LocalEmailMessage {
  from: string;
  to: string;
  [RAW_EMAIL]: ReadableStream<Uint8Array>;
}

type EmailAttachment = {
  disposition: "inline" | "attachment";
  contentId?: string;
  filename: string;
  type: string;
  content: string | ArrayBuffer | ArrayBufferView;
};

interface EmailAddress {
  name: string;
  email: string;
}

interface MessageBuilder {
  from: string | EmailAddress;
  to: string | EmailAddress | Array<string | EmailAddress>;
  subject: string;
  replyTo?: string | EmailAddress;
  cc?: string | EmailAddress | Array<string | EmailAddress>;
  bcc?: string | EmailAddress | Array<string | EmailAddress>;
  headers?: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: Array<EmailAttachment>;
}

interface EmailSendResult {
  messageId: string;
}

// -----------------------------------------------------------------------------
// Helpers (`workers/email/send_email.worker.ts`)
// -----------------------------------------------------------------------------

/**
 * Build a Message-ID in the shape the production `send_email` binding returns:
 * `<{36 alphanumeric chars}@{sender domain}>`, brackets included. The body is
 * random — production synthesizes its own id rather than echoing any header
 * present in the submitted email.
 */
function synthesizeMessageId(senderEmail: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(36));
  const id = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  const domain = senderEmail.slice(senderEmail.lastIndexOf("@") + 1);
  return `<${id}@${domain}>`;
}

/**
 * Extracts the bare email address from a string (which may be in
 * `"Name" <address>` or plain address format) or EmailAddress object.
 */
function extractEmailAddress(addr: string | EmailAddress): string {
  if (typeof addr !== "string") {
    return addr.email;
  }
  // Match "Name" <address> or Name <address> or just address
  const match = addr.match(/<([^>]+)>$/);
  return match ? match[1].trim() : addr.trim();
}

/** Formats an email address for display. */
function formatEmailAddress(addr: string | EmailAddress): string {
  if (typeof addr === "string") {
    return addr;
  }
  return `"${addr.name}" <${addr.email}>`;
}

/** Formats a MessageBuilder for logging. */
function formatMessageBuilder(builder: MessageBuilder): string {
  const lines: Array<string> = [];

  lines.push("From: " + formatEmailAddress(builder.from));

  const toArray = Array.isArray(builder.to) ? builder.to : [builder.to];
  lines.push("To: " + toArray.map(formatEmailAddress).join(", "));

  if (builder.cc) {
    const ccArray = Array.isArray(builder.cc) ? builder.cc : [builder.cc];
    lines.push("Cc: " + ccArray.map(formatEmailAddress).join(", "));
  }

  if (builder.bcc) {
    const bccArray = Array.isArray(builder.bcc) ? builder.bcc : [builder.bcc];
    lines.push("Bcc: " + bccArray.map(formatEmailAddress).join(", "));
  }

  lines.push("Subject: " + builder.subject);

  return lines.join("\n");
}

/**
 * Appends path segments to a base path using the separator already implied by
 * the base path string. This trims trailing `/` and `\` from the base before
 * joining, but does not otherwise normalize the full path.
 */
function joinPath(base: string, ...segments: Array<string>): string {
  const separator = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...segments].join(separator);
}

interface SendEmailEnv {
  [BINDING_SEND_EMAIL_DISK]: Fetcher;
  [BINDING_SEND_EMAIL_DIRECTORY]: string;
}

// -----------------------------------------------------------------------------
// Entrypoint (`workers/email/send_email.worker.ts` `SendEmailBinding`)
// -----------------------------------------------------------------------------

export class SendEmailBinding extends WorkerEntrypoint<SendEmailEnv> {
  private get props(): SendEmailServiceProps {
    return (this.ctx as { props?: SendEmailServiceProps }).props ?? {};
  }

  /**
   * Stores content through the disk service. `subdirectory` segments are
   * created on demand by workerd's disk service.
   */
  private async storeFile(
    content: string | ArrayBuffer | ArrayBufferView,
    extension: string,
    subdirectory?: string,
  ): Promise<string> {
    let body: string | Uint8Array;
    if (typeof content === "string") {
      body = content;
    } else if (content instanceof ArrayBuffer) {
      body = new Uint8Array(content);
    } else {
      // ArrayBufferView
      body = new Uint8Array(
        content.buffer,
        content.byteOffset,
        content.byteLength,
      );
    }

    const fileName = `${crypto.randomUUID()}.${extension}`;
    const segments = subdirectory ? [subdirectory, fileName] : [fileName];
    const url = new URL(segments.join("/"), "http://placeholder/");
    await this.env[BINDING_SEND_EMAIL_DISK].fetch(url, {
      method: "PUT",
      body,
    });

    return joinPath(this.env[BINDING_SEND_EMAIL_DIRECTORY], ...segments);
  }

  private checkDestinationAllowed(to: string): void {
    const { destinationAddress, allowedDestinationAddresses } = this.props;
    if (destinationAddress !== undefined && to !== destinationAddress) {
      throw new Error(`email to ${to} not allowed`);
    }

    if (
      allowedDestinationAddresses !== undefined &&
      !allowedDestinationAddresses.includes(to)
    ) {
      throw new Error(`email to ${to} not allowed`);
    }
  }

  private checkSenderAllowed(from: string): void {
    const { allowedSenderAddresses } = this.props;
    if (
      allowedSenderAddresses !== undefined &&
      !allowedSenderAddresses.includes(from)
    ) {
      throw new Error(`email from ${from} not allowed`);
    }
  }

  /** Type guard to check if argument is an EmailMessage (has RAW_EMAIL key). */
  private isEmailMessage(
    arg: LocalEmailMessage | MessageBuilder,
  ): arg is LocalEmailMessage {
    return RAW_EMAIL in arg;
  }

  /** Validates recipients against the binding configuration. */
  private validateRecipients(recipients: string | Array<string>): void {
    const recipientArray = Array.isArray(recipients)
      ? recipients
      : [recipients];
    for (const recipient of recipientArray) {
      this.checkDestinationAllowed(recipient);
    }
  }

  /** Validates a MessageBuilder against the binding configuration. */
  private validateMessageBuilder(builder: MessageBuilder): void {
    // Check sender is allowed
    const fromEmail = extractEmailAddress(builder.from);
    this.checkSenderAllowed(fromEmail);

    // Check "to" recipients are allowed (same as EmailMessage - only validate "to")
    const toArray = Array.isArray(builder.to) ? builder.to : [builder.to];
    const toEmails = toArray.map((addr) => extractEmailAddress(addr));
    this.validateRecipients(toEmails);
  }

  async send(
    emailMessageOrBuilder: LocalEmailMessage | MessageBuilder,
  ): Promise<EmailSendResult> {
    // Check if this is an EmailMessage (has RAW_EMAIL key) or MessageBuilder
    if (this.isEmailMessage(emailMessageOrBuilder)) {
      // Original EmailMessage API - validate and parse MIME
      const emailMessage = emailMessageOrBuilder;
      this.checkSenderAllowed(emailMessage.from);
      this.validateRecipients(emailMessage.to);

      const rawEmail: ReadableStream<Uint8Array> = emailMessage[RAW_EMAIL];
      const rawEmailBuffer = new Uint8Array(
        await new Response(rawEmail).arrayBuffer(),
      );

      let parsedEmail: Email;

      try {
        parsedEmail = await PostalMime.parse(rawEmailBuffer);
      } catch (e) {
        const error = e as Error;
        throw new Error(`could not parse email: ${error.message}`, {
          cause: e,
        });
      }

      if (parsedEmail.messageId === undefined) {
        throw new Error("invalid message-id");
      }

      let emailHeaders: Headers;
      try {
        emailHeaders = new Headers(
          parsedEmail.headers.map((header) => [header.key, header.value]),
        );
      } catch (e) {
        const error = e as Error;
        throw new Error(`could not parse email: ${error.message}`, {
          cause: e,
        });
      }

      if (emailMessage.from !== parsedEmail.from?.address) {
        throw new Error("From: header does not match mail from");
      }

      if (emailHeaders.get("received") !== null) {
        throw new Error("invalid headers set");
      }

      const file = await this.storeFile(rawEmailBuffer, "eml");

      console.log(
        `send_email binding called with the following message:\n  ${file}`,
      );

      return { messageId: synthesizeMessageId(emailMessage.from) };
    } else {
      // MessageBuilder API - validate, persist parts, and log
      const builder = emailMessageOrBuilder;

      this.validateMessageBuilder(builder);

      // Store text, HTML content, and attachments to files for easy viewing
      const files: Array<string> = [];

      if (builder.text) {
        const filePath = await this.storeFile(builder.text, "txt", "text");
        files.push(`Text: ${filePath}`);
      }

      if (builder.html) {
        const filePath = await this.storeFile(builder.html, "html", "html");
        files.push(`HTML: ${filePath}`);
      }

      if (builder.attachments) {
        for (const attachment of builder.attachments) {
          // Extract file extension from filename or use generic extension
          const extMatch = attachment.filename.match(/\.([^.]+)$/);
          const extension = extMatch ? extMatch[1] : "bin";

          const filePath = await this.storeFile(
            attachment.content,
            extension,
            "attachment",
          );
          files.push(
            `Attachment (${attachment.disposition}): ${attachment.filename} -> ${filePath}`,
          );
        }
      }

      // Format and log the message details with file paths
      const formatted = formatMessageBuilder(builder);
      const fileInfo = files.length > 0 ? `\n\n${files.join("\n")}` : "";
      console.log(
        `send_email binding called with MessageBuilder:\n${formatted}${fileInfo}`,
      );

      return {
        messageId: synthesizeMessageId(extractEmailAddress(builder.from)),
      };
    }
  }
}

export default {
  // The service is only addressed via the `SendEmailBinding` entrypoint; a
  // default handler is still required for the worker to be a valid service.
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
