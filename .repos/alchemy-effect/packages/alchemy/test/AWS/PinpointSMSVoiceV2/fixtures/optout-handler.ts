import * as Lambda from "@/AWS/Lambda";
import * as PinpointSMSVoiceV2 from "@/AWS/PinpointSMSVoiceV2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "optout-handler.ts");

/**
 * Destination number the fixture opts out/in — the US simulator success
 * number, so no real end user is ever affected.
 */
export const TEST_DESTINATION = "+14254147755";

export class SmsVoiceOptOutTestFunction extends Lambda.Function<Lambda.Function>()(
  "SmsVoiceOptOutTestFunction",
) {}

export default SmsVoiceOptOutTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const optOuts = yield* PinpointSMSVoiceV2.OptOutList("BindingsOptOuts", {
      tags: { fixture: "smsvoice-bindings" },
    });

    const putOptedOut = yield* PinpointSMSVoiceV2.PutOptedOutNumber(optOuts);
    const describeOptedOut =
      yield* PinpointSMSVoiceV2.DescribeOptedOutNumbers(optOuts);
    const deleteOptedOut =
      yield* PinpointSMSVoiceV2.DeleteOptedOutNumber(optOuts);
    const carrierLookup = yield* PinpointSMSVoiceV2.CarrierLookup();
    const putFeedback = yield* PinpointSMSVoiceV2.PutMessageFeedback();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/opt-out") {
          const result = yield* putOptedOut({
            OptedOutNumber: TEST_DESTINATION,
          });
          return yield* HttpServerResponse.json({
            optedOutNumber: result.OptedOutNumber,
            endUserOptedOut: result.EndUserOptedOut,
          });
        }

        if (request.method === "POST" && pathname === "/opt-out-check") {
          const result = yield* describeOptedOut({
            OptedOutNumbers: [TEST_DESTINATION],
          }).pipe(
            Effect.map((r) => ({
              count: (r.OptedOutNumbers ?? []).length,
              numbers: (r.OptedOutNumbers ?? []).map((n) => n.OptedOutNumber),
            })),
            // Filtering for a number that isn't in the list raises the
            // typed not-found tag — semantically "0 opted out".
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({
                count: 0,
                numbers: [] as (string | undefined)[],
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/opt-out-delete") {
          const result = yield* deleteOptedOut({
            OptedOutNumber: TEST_DESTINATION,
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              deleted: r.OptedOutNumber,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "ValidationException",
                "ThrottlingException",
                "InternalServerException",
              ],
              (e) =>
                Effect.succeed({
                  ok: false as const,
                  tag: e._tag,
                  message: e.message,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/carrier-lookup") {
          // The lookup may reject the simulator number as unsupported —
          // surface the typed tag so the test can assert IAM allowed the
          // call (an AccessDeniedException would prove a broken grant).
          const result = yield* carrierLookup({
            PhoneNumber: TEST_DESTINATION,
          }).pipe(
            Effect.map((info) => ({
              ok: true as const,
              e164PhoneNumber: info.E164PhoneNumber,
              phoneNumberType: info.PhoneNumberType,
            })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ValidationException",
                "ServiceQuotaExceededException",
                "ThrottlingException",
                "InternalServerException",
              ],
              (e) =>
                Effect.succeed({
                  ok: false as const,
                  tag: e._tag,
                  message: e.message,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/feedback-probe") {
          // No real MessageId exists ungated — assert the typed
          // ResourceNotFoundException surfaces, proving the grant and the
          // request wiring (a broken grant would AccessDeniedException).
          const result = yield* putFeedback({
            MessageId: "00000000-0000-0000-0000-000000000000",
            MessageFeedbackStatus: "RECEIVED",
          }).pipe(
            Effect.map((r) => ({ ok: true as const, messageId: r.MessageId })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "ValidationException",
                "ThrottlingException",
                "InternalServerException",
              ],
              (e) =>
                Effect.succeed({
                  ok: false as const,
                  tag: e._tag,
                  message: e.message,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
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
        PinpointSMSVoiceV2.PutOptedOutNumberHttp,
        PinpointSMSVoiceV2.DescribeOptedOutNumbersHttp,
        PinpointSMSVoiceV2.DeleteOptedOutNumberHttp,
        PinpointSMSVoiceV2.CarrierLookupHttp,
        PinpointSMSVoiceV2.PutMessageFeedbackHttp,
      ),
    ),
  ),
);
