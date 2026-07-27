import * as Lambda from "@/AWS/Lambda";
import * as PinpointSMSVoiceV2 from "@/AWS/PinpointSMSVoiceV2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "phone-handler.ts");

/**
 * Destination the fixture sends to — the US simulator success number, so
 * sends complete without a registered/verified destination and no real
 * end user is ever contacted.
 */
export const SIMULATOR_DESTINATION = "+14254147755";

export class SmsVoicePhoneTestFunction extends Lambda.Function<Lambda.Function>()(
  "SmsVoicePhoneTestFunction",
) {}

export default SmsVoicePhoneTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // SIMULATOR numbers only exchange messages with simulator
    // destinations and carry the smallest leasing cost.
    const number = yield* PinpointSMSVoiceV2.PhoneNumber("BindingsNumber", {
      isoCountryCode: "US",
      messageType: "TRANSACTIONAL",
      numberCapabilities: ["SMS"],
      numberType: "SIMULATOR",
      tags: { fixture: "smsvoice-bindings" },
    });

    const sendText = yield* PinpointSMSVoiceV2.SendTextMessage(number);
    const sendVoice = yield* PinpointSMSVoiceV2.SendVoiceMessage(number);
    const sendMedia = yield* PinpointSMSVoiceV2.SendMediaMessage(number);
    const putKeyword = yield* PinpointSMSVoiceV2.PutKeyword(number);
    const describeKeywords = yield* PinpointSMSVoiceV2.DescribeKeywords(number);
    const deleteKeyword = yield* PinpointSMSVoiceV2.DeleteKeyword(number);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/send-text") {
          const { MessageId } = yield* sendText({
            DestinationPhoneNumber: SIMULATOR_DESTINATION,
            MessageBody: "hello from alchemy",
            MessageType: "TRANSACTIONAL",
          });
          return yield* HttpServerResponse.json({ messageId: MessageId });
        }

        if (request.method === "POST" && pathname === "/send-voice") {
          // The SIMULATOR number is leased with SMS capability only —
          // surface the typed tag so the test can assert IAM allowed the
          // call regardless of the capability verdict.
          const result = yield* sendVoice({
            DestinationPhoneNumber: SIMULATOR_DESTINATION,
            MessageBody: "hello from alchemy",
          }).pipe(
            Effect.map((r) => ({ ok: true as const, messageId: r.MessageId })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ConflictException",
                "ResourceNotFoundException",
                "ServiceQuotaExceededException",
                "ThrottlingException",
                "ValidationException",
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

        if (request.method === "POST" && pathname === "/send-media") {
          const result = yield* sendMedia({
            DestinationPhoneNumber: SIMULATOR_DESTINATION,
            MessageBody: "hello from alchemy (mms)",
          }).pipe(
            Effect.map((r) => ({ ok: true as const, messageId: r.MessageId })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ConflictException",
                "ResourceNotFoundException",
                "ServiceQuotaExceededException",
                "ThrottlingException",
                "ValidationException",
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

        if (request.method === "POST" && pathname === "/keyword-put") {
          const result = yield* putKeyword({
            Keyword: "INFO",
            KeywordMessage: "Visit https://alchemy.run for details.",
          });
          return yield* HttpServerResponse.json({
            keyword: result.Keyword,
            message: result.KeywordMessage,
          });
        }

        if (request.method === "POST" && pathname === "/keyword-list") {
          const result = yield* describeKeywords({});
          return yield* HttpServerResponse.json({
            keywords: (result.Keywords ?? []).map((k) => k.Keyword),
          });
        }

        if (request.method === "POST" && pathname === "/keyword-delete") {
          const result = yield* deleteKeyword({ Keyword: "INFO" });
          return yield* HttpServerResponse.json({ deleted: result.Keyword });
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
        PinpointSMSVoiceV2.SendTextMessageHttp,
        PinpointSMSVoiceV2.SendVoiceMessageHttp,
        PinpointSMSVoiceV2.SendMediaMessageHttp,
        PinpointSMSVoiceV2.PutKeywordHttp,
        PinpointSMSVoiceV2.DescribeKeywordsHttp,
        PinpointSMSVoiceV2.DeleteKeywordHttp,
      ),
    ),
  ),
);
