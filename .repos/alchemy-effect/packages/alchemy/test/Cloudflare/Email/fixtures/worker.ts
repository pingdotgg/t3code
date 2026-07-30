import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Email } from "./sender.ts";

export default class SendEmailWorker extends Cloudflare.Worker<SendEmailWorker>()(
  "SendEmailTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const email = yield* Cloudflare.Email.Send(Email);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/send") {
          const from = url.searchParams.get("from")!;
          const to = url.searchParams.get("to")!;
          const subject = url.searchParams.get("subject") ?? "alchemy test";
          const result = yield* email
            .send({
              from,
              to,
              subject,
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
