import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Worker-runtime config loaded via Effect's `Config`. Captured during the
 * Init phase below, which makes Alchemy bind them as `plain_text` on the
 * Worker — at runtime the same `Config` calls re-resolve from those
 * bindings via the runtime `ConfigProvider`.
 *
 * The zone and inbox default to the standing test zone so the deploy-time
 * half of the event source (the auto-created `Email.Routing` +
 * `Email.Rule`) is always exercised. Only the outbound sender is optional —
 * the send→receive round trip needs a verified destination, which not every
 * account has.
 */
const ZoneConfig = Config.string("CLOUDFLARE_TEST_DNS_ZONE_NAME").pipe(
  Config.withDefault("alchemy-test-2.us"),
);
const InboxConfig = Config.string("CLOUDFLARE_TEST_EMAIL_INBOX").pipe(
  Config.withDefault(""),
);
const SenderConfig = Config.string("CLOUDFLARE_TEST_EMAIL_FROM").pipe(
  Config.withDefault(""),
);

interface ReceivedMessage {
  from: string;
  to: string;
  subject: string | null;
  bodySize: number;
  receivedAt: number;
}

/**
 * Durable Object that records every message the worker's email handler
 * sees. The test polls `snapshot()` via `GET /received` to confirm the
 * inbound dispatch actually fired.
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
 * Fixture worker for `EmailEventSource.test.ts`.
 *
 * Wires `Cloudflare.email({ zone, matchers }).subscribe(...)` to record
 * each inbound message on an `Inbox` DO, and exposes:
 *
 * - `POST /send` — emits an outbound message via the `send_email` binding
 *   to the address the worker also subscribes to.
 * - `GET /received` — snapshot of recorded inbound messages.
 * - `POST /reset` — clear the DO state.
 * - `GET /config` — the zone/inbox the subscribe was wired to, so the
 *   test can assert against the same values the Worker resolved.
 *
 * The deploy-time policy auto-creates `Email.Routing` + `Email.Rule` so no
 * routing wiring is needed in the test stack.
 */
export default class EmailTestWorker extends Cloudflare.Worker<EmailTestWorker>()(
  "EmailTestWorker",
  {
    main: import.meta.filename,
    workersDev: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const inboxes = yield* Inbox;

    // Resolve the Configs once at Init. At deploy time these come from
    // Node's env (loaded by the Stack); Alchemy then binds the resolved
    // values onto the Worker as plain_text so the same Config calls
    // re-resolve from bindings at runtime.
    const zone = yield* ZoneConfig;
    const inboxAddress = (yield* InboxConfig) || `inbox@${zone}`;
    const senderAddress = yield* SenderConfig;

    // `send_email` binding the test worker uses to seed a message into
    // the inbox it also subscribes to.
    const Sender = yield* Cloudflare.Email.SendEmail("Sender", {
      allowedSenderAddresses: senderAddress ? [senderAddress] : undefined,
      destinationAddress: inboxAddress,
    });
    const sender = yield* Cloudflare.Email.Send(Sender);

    // Always subscribe: this is the deploy-time half under test, and it
    // needs no mail to flow to be verifiable.
    yield* Cloudflare.email({
      zone,
      matchers: [{ type: "literal", field: "to", value: inboxAddress }],
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

        if (request.method === "GET" && url.pathname === "/config") {
          return yield* HttpServerResponse.json({ zone, inbox: inboxAddress });
        }

        if (request.method === "GET" && url.pathname === "/received") {
          const snapshot = yield* inboxes.getByName("default").snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* inboxes.getByName("default").reset();
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/send") {
          if (!senderAddress) {
            return yield* HttpServerResponse.json(
              {
                ok: false,
                message: "CLOUDFLARE_TEST_EMAIL_FROM is required",
              },
              { status: 400 },
            );
          }
          const subject =
            url.searchParams.get("subject") ??
            `alchemy email test ${Date.now()}`;
          const result = yield* sender
            .send({
              from: senderAddress,
              to: inboxAddress,
              subject,
              text: `sent at ${new Date().toISOString()}`,
            })
            .pipe(
              Effect.match({
                onSuccess: () => ({ ok: true as const, subject }),
                onFailure: (err) => ({
                  ok: false as const,
                  message: err.message,
                }),
              }),
            );
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.EmailEventSourceLive),
    Effect.provide(Cloudflare.Email.SendBinding),
  ),
) {}
