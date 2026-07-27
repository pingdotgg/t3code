import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DESTINATION, SendEmail, SENDER } from "./Email.ts";

/**
 * Minimal email service Worker.
 *
 * - `GET /healthz` — liveness probe.
 * - `POST /send` body `{ subject, text }` — sends mail from the bound
 *   sender to the bound destination via the Worker's `send_email`
 *   binding. Returns `{ ok: true }` on success or `{ ok: false, message }`
 *   on a Cloudflare-side rejection (e.g. unverified destination).
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const email = yield* Cloudflare.Email.Send(SendEmail);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/healthz") {
          return yield* HttpServerResponse.json({
            ok: true,
            from: SENDER,
            to: DESTINATION,
          });
        }

        if (url.pathname === "/send" && request.method === "POST") {
          const body = (yield* request.json) as {
            subject?: string;
            text?: string;
          };
          const result = yield* email
            .send({
              from: SENDER,
              to: DESTINATION,
              subject: body.subject ?? "alchemy email example",
              text: body.text ?? `sent at ${new Date().toISOString()}`,
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

        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Email.SendBinding)),
) {}
