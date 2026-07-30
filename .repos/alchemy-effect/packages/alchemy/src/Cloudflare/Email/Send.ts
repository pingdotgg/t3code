import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SendEmail } from "./SendEmail.ts";

/**
 * Bind a {@link SendEmail} `send_email` descriptor to a Worker and obtain the
 * Effect-native client for sending email.
 *
 * `Send` is a single identifier that is simultaneously the binding's Context
 * tag, its type, and the callable — `yield* Cloudflare.Email.Send(EmailDescriptor)`.
 *
 * @example Send to any verified destination
 * ```typescript
 * const Email = Cloudflare.Email.SendEmail("Email");
 *
 * // in the Worker effect:
 * const email = yield* Cloudflare.Email.Send(Email);
 * yield* email.send({
 *   from: "noreply@example.com",
 *   to: "user@example.com",
 *   subject: "Hello",
 *   text: "Hi from Alchemy",
 * });
 * ```
 *
 * @binding
 * @product Email
 * @category Email
 */
export interface Send extends Binding.Service<
  Send,
  "Cloudflare.Email.SendEmail",
  (sender: SendEmail) => Effect.Effect<SendClient>
> {}

export const Send = Binding.Service<Send>("Cloudflare.Email.SendEmail");

/**
 * Email body shape for the builder-form `send` call. Either `text`, `html`,
 * or both must be provided.
 */
export interface SendEmailMessage {
  from: string | runtime.EmailAddress;
  to: string | string[];
  subject: string;
  replyTo?: string | runtime.EmailAddress;
  cc?: string | string[];
  bcc?: string | string[];
  headers?: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: runtime.EmailAttachment[];
}

export class SendEmailError extends Data.TaggedError("SendEmailError")<{
  message: string;
  cause?: unknown;
}> {}

export interface SendClient {
  /**
   * The raw runtime `SendEmail` binding. Use this when you need direct
   * access to the Cloudflare object (e.g. to send a pre-built
   * `EmailMessage` from `cloudflare:email`).
   */
  raw: Effect.Effect<runtime.SendEmail, never, RuntimeContext>;
  /**
   * Send an email using the builder form. Equivalent to calling
   * `env.<name>.send({ from, to, subject, text, html, ... })`.
   */
  send(
    message: SendEmailMessage,
  ): Effect.Effect<runtime.EmailSendResult, SendEmailError, RuntimeContext>;
  /**
   * Send a raw `EmailMessage` (constructed via `cloudflare:email`).
   */
  sendRaw(
    message: runtime.EmailMessage,
  ): Effect.Effect<runtime.EmailSendResult, SendEmailError, RuntimeContext>;
}
