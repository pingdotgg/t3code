import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DESTINATION, INBOX, SendEmail, SENDER, ZONE } from "./Email.ts";

interface ReceivedMessage {
  from: string;
  to: string;
  subject: string | null;
  bodySize: number;
  receivedAt: number;
}

/**
 * Durable Object that records every message the Worker's `email` handler
 * sees so the integ test can confirm an inbound message round-tripped
 * through Cloudflare's email routing.
 */
export class Inbox extends Cloudflare.DurableObject<Inbox>()(
  "Inbox",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      let received =
        (yield* state.storage.get<ReceivedMessage[]>("received")) ?? [];
      return {
        record: Effect.fn(function* (msg: ReceivedMessage) {
          received = [...received, msg];
          yield* state.storage.put("received", received);
        }),
        snapshot: () => Effect.succeed({ received }),
        reset: Effect.fn(function* () {
          received = [];
          yield* state.storage.put("received", received);
        }),
      };
    });
  }),
) {}

/**
 * Email service Worker. Demonstrates both halves of a Cloudflare Email
 * Worker:
 *
 * - **Inbound** — `Cloudflare.email({ zone, matchers }).subscribe(...)`
 *   auto-creates an `EmailRouting` toggle on the zone and an `EmailRule`
 *   whose `actions: [{ type: "worker", … }]` targets this Worker. The
 *   handler records each message on the `Inbox` DO.
 * - **Outbound** — the `send_email` binding from `Email.ts` lets the
 *   Worker emit mail from the configured sender to the verified
 *   destination.
 *
 * Routes:
 *
 * - `GET /healthz` — liveness probe; reports the configured addresses.
 * - `POST /send` body `{ subject, text }` — sends mail from sender to
 *   destination via the `send_email` binding.
 * - `GET /received` — snapshot of messages the `email` handler has seen.
 * - `POST /reset` — clear the recorded inbox (used by the integ test).
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const email = yield* Cloudflare.Email.Send(SendEmail);
    const inboxes = yield* Inbox;

    // Subscribe to inbound mail addressed to INBOX on ZONE. The event
    // source yields a sibling `Email.Routing` + `Email.Rule` at deploy
    // time so no hand-rolled routing wiring is needed in `alchemy.run.ts`.
    yield* Cloudflare.email({
      zone: ZONE,
      matchers: [{ type: "literal", field: "to", value: INBOX }],
    }).subscribe((message) =>
      inboxes.getByName("default").record({
        from: message.from,
        to: message.to,
        subject: message.headers.get("subject"),
        bodySize: message.bodySize,
        receivedAt: Date.now(),
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/healthz") {
          return yield* HttpServerResponse.json({
            ok: true,
            from: SENDER,
            to: DESTINATION,
            inbox: INBOX,
          });
        }

        if (url.pathname === "/received" && request.method === "GET") {
          const snapshot = yield* inboxes.getByName("default").snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        if (url.pathname === "/reset" && request.method === "POST") {
          yield* inboxes.getByName("default").reset();
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (url.pathname === "/send" && request.method === "POST") {
          const body = (yield* request.json) as {
            subject?: string;
            text?: string;
            to?: string;
          };
          const result = yield* email
            .send({
              from: SENDER,
              to: body.to ?? DESTINATION,
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
  }).pipe(
    Effect.provide(Cloudflare.EmailEventSourceLive),
    Effect.provide(Cloudflare.Email.SendBinding),
  ),
) {}
