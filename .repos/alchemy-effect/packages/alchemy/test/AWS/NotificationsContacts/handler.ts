import * as Lambda from "@/AWS/Lambda";
import * as NotificationsContacts from "@/AWS/NotificationsContacts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** Deterministic identity for the fixture's contact. */
export const CONTACT_NAME = "alchemy-test-contact-bindings";
export const CONTACT_EMAIL = "sam+alchemy-test-contact-bindings@alchemy.run";

export class NotificationsContactsTestFunction extends Lambda.Function<Lambda.Function>()(
  "NotificationsContactsTestFunction",
) {}

export default NotificationsContactsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const contact = yield* NotificationsContacts.EmailContact(
      "BindingsContact",
      {
        name: CONTACT_NAME,
        emailAddress: CONTACT_EMAIL,
        tags: { fixture: "notificationscontacts-bindings" },
      },
    );

    const getContact = yield* NotificationsContacts.GetEmailContact(contact);
    const sendActivationCode =
      yield* NotificationsContacts.SendActivationCode(contact);
    const activate = yield* NotificationsContacts.ActivateEmailContact(contact);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/contact") {
          const result = yield* getContact();
          // name/address are sensitive — assert on shape/status only.
          return yield* HttpServerResponse.json({
            arn: result.emailContact.arn,
            status: result.emailContact.status,
          });
        }

        if (request.method === "POST" && pathname === "/send-code") {
          const sent = yield* sendActivationCode().pipe(
            Effect.map(() => ({ sent: true, conflict: false })),
            // Already-active contacts (or a recent resend) surface as the
            // typed ConflictException — either outcome proves the binding.
            Effect.catchTag("ConflictException", () =>
              Effect.succeed({ sent: false, conflict: true }),
            ),
          );
          return yield* HttpServerResponse.json(sent);
        }

        if (request.method === "POST" && pathname === "/activate-bogus") {
          // Activation needs the code from the activation email (a human
          // loop) — a bogus code must surface a TYPED error, which proves
          // both the IAM grant and the request wiring.
          const result = yield* Effect.result(
            activate({ code: Redacted.make("000000") }),
          );
          if (Result.isFailure(result)) {
            return yield* HttpServerResponse.json({
              activated: false,
              errorTag: result.failure._tag,
            });
          }
          return yield* HttpServerResponse.json({ activated: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NotificationsContacts.GetEmailContactHttp,
        NotificationsContacts.SendActivationCodeHttp,
        NotificationsContacts.ActivateEmailContactHttp,
      ),
    ),
  ),
);
