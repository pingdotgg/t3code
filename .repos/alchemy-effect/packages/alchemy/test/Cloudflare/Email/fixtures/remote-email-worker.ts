import * as Cloudflare from "@/Cloudflare/index.ts";
import { remote } from "@/ProviderMode.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const senderAddress = process.env.CLOUDFLARE_TEST_EMAIL_FROM;
const destinationAddress = process.env.CLOUDFLARE_TEST_EMAIL_TO;

/**
 * `send_email` descriptor opted into the REAL binding under `alchemy dev`
 * via `Alchemy.remote()`: the local worker proxies `send()` through the
 * remote-bindings preview session to Cloudflare's live Email service, so it
 * needs a verified sender/destination pair from the env.
 */
export const RemoteEmail = Cloudflare.Email.SendEmail("RemoteEmail", {
  allowedSenderAddresses: senderAddress ? [senderAddress] : undefined,
  destinationAddress,
}).pipe(remote());

export default class RemoteEmailWorker extends Cloudflare.Worker<RemoteEmailWorker>()(
  "SendEmailRemoteDevTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const email = yield* Cloudflare.Email.Send(RemoteEmail);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/send") {
          const from = url.searchParams.get("from")!;
          const to = url.searchParams.get("to")!;
          const result = yield* email
            .send({
              from,
              to,
              subject: "alchemy dev remote send_email test",
              text: `sent at ${new Date().toISOString()}`,
            })
            .pipe(
              Effect.match({
                onSuccess: () => ({ ok: true as const }),
                onFailure: (err) => ({
                  ok: false as const,
                  message: err.message,
                }),
              }),
            );
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Email.SendBinding)),
) {}
