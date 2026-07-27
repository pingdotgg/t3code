import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import {
  Send,
  SendEmailError,
  type SendClient,
  type SendEmailMessage,
} from "./Send.ts";
import type { SendEmail } from "./SendEmail.ts";

export const SendBinding = Layer.effect(
  Send,
  Effect.gen(function* () {
    const host = yield* Worker;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (sender: SendEmail) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
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
      }

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
      } satisfies SendClient;
    });
  }),
);
