import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { SendEmail } from "./SendEmail.ts";

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

export interface SendEmailClient {
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

/**
 * A typed runtime accessor for a Cloudflare `send_email` Worker binding.
 *
 * @binding
 */
export class SendEmailBinding extends Binding.Service<
  SendEmailBinding,
  (sender: SendEmail) => Effect.Effect<SendEmailClient>
>()("Cloudflare.SendEmail.Binding") {}

export const SendEmailBindingLive = Layer.effect(
  SendEmailBinding,
  Effect.gen(function* () {
    const bind = yield* SendEmailBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fnUntraced(function* (sender: SendEmail) {
      yield* bind(sender);

      const raw = Effect.sync(
        () => (env as Record<string, runtime.SendEmail>)[sender.name]!,
      );

      const tryPromise = <T>(
        fn: () => Promise<T>,
      ): Effect.Effect<T, SendEmailError> =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new SendEmailError({
              message: error?.message ?? "Unknown send_email error",
              cause: error,
            }),
        });

      return {
        raw,
        send: (message: SendEmailMessage) =>
          raw.pipe(Effect.flatMap((s) => tryPromise(() => s.send(message)))),
        sendRaw: (message: runtime.EmailMessage) =>
          raw.pipe(Effect.flatMap((s) => tryPromise(() => s.send(message)))),
      } satisfies SendEmailClient;
    });
  }),
);

export class SendEmailBindingPolicy extends Binding.Policy<
  SendEmailBindingPolicy,
  (sender: SendEmail) => Effect.Effect<void>
>()("Cloudflare.SendEmail.Binding") {}

export const SendEmailBindingPolicyLive = SendEmailBindingPolicy.layer.succeed(
  Effect.fnUntraced(function* (host: ResourceLike, sender: SendEmail) {
    if (isWorker(host)) {
      yield* host.bind(sender.name, {
        bindings: [
          {
            type: "send_email",
            name: sender.name,
            destinationAddress: sender.destinationAddress,
            allowedDestinationAddresses: sender.allowedDestinationAddresses,
            allowedSenderAddresses: sender.allowedSenderAddresses,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`SendEmailBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);
