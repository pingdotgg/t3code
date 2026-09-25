import * as Cloudflare from "@/Cloudflare/index.ts";
import { remote } from "@/ProviderMode.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Dev-mode fixture with two `send_email` bindings side by side: the default
 * (lowered onto the local email simulator) and one piped through
 * `Alchemy.remote()` (the live Cloudflare Email service, even in dev).
 */
export default class LocalSendEmailWorker extends Cloudflare.Worker<LocalSendEmailWorker>()(
  "LocalSendEmailWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const stub = yield* Cloudflare.Email.Send(
      Cloudflare.Email.SendEmail("STUB_EMAIL"),
    );
    const live = yield* Cloudflare.Email.Send(
      Cloudflare.Email.SendEmail("LIVE_EMAIL").pipe(remote()),
    );

    const send = Effect.fn(function* (client: Cloudflare.Email.SendClient) {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://x");
      const result = yield* client
        .send({
          from: url.searchParams.get("from")!,
          to: url.searchParams.get("to")!,
          subject: url.searchParams.get("subject") ?? "alchemy local test",
          text: "sent from the alchemy dev-mode send_email test",
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
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/send-stub") {
          return yield* send(stub);
        }
        if (url.pathname === "/send-live") {
          return yield* send(live);
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Email.SendBinding)),
) {}
