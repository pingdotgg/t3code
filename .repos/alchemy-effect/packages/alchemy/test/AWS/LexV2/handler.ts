import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as LexV2 from "@/AWS/LexV2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class LexTestFunction extends Lambda.Function<Lambda.Function>()(
  "LexTestFunction",
) {}

const contentOf = (
  content: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  content === undefined
    ? undefined
    : typeof content === "string"
      ? content
      : Redacted.value(content);

/**
 * Surface a typed failure as JSON. Only `AccessDeniedException` (fresh IAM
 * policy propagation) maps to a retryable 502 — any other tag is terminal
 * and returns 400 so the test fails fast with the tag visible.
 */
const respond = <A, E extends { readonly _tag: string }>(
  self: Effect.Effect<A, E>,
  onSuccess: (a: A) => Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(self);
    if (Result.isFailure(result)) {
      return yield* HttpServerResponse.json(
        {
          error: result.failure._tag,
          message: String(
            (result.failure as { message?: string }).message ?? "",
          ),
        },
        {
          status: result.failure._tag === "AccessDeniedException" ? 502 : 400,
        },
      );
    }
    return yield* HttpServerResponse.json(onSuccess(result.success));
  });

export default LexTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The whole Lex chain: role -> bot -> DRAFT locale -> intents -> built
    // version -> alias. BotVersion builds the locale before snapshotting.
    const role = yield* IAM.Role("LexBotRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lexv2.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });
    const bot = yield* LexV2.Bot("E2EBot", {
      roleArn: role.roleArn,
      description: "alchemy lex recognize-text e2e bot",
    });
    const locale = yield* LexV2.BotLocale("En", {
      botId: bot.botId,
      localeId: "en_US",
    });
    const greet = yield* LexV2.Intent("Greet", {
      botId: locale.botId,
      localeId: locale.localeId,
      intentName: "Greet",
      sampleUtterances: ["hello", "hi", "hey there"],
    });
    // Slotless intent fulfilled by this function's code hook.
    const order = yield* LexV2.Intent("Order", {
      botId: greet.botId,
      localeId: greet.localeId,
      intentName: "OrderPizza",
      sampleUtterances: ["order a pizza", "I want to order a pizza"],
      fulfillmentCodeHook: true,
    });
    const version = yield* LexV2.BotVersion("V1", {
      botId: order.botId,
      localeIds: [order.localeId],
    });
    const alias = yield* LexV2.BotAlias("Live", {
      botId: version.botId,
      botVersion: version.botVersion,
    });

    const recognizeText = yield* LexV2.RecognizeText(alias);
    const recognizeUtterance = yield* LexV2.RecognizeUtterance(alias);
    const getSession = yield* LexV2.GetSession(alias);
    const putSession = yield* LexV2.PutSession(alias);
    const deleteSession = yield* LexV2.DeleteSession(alias);

    // Fulfillment code hook: Lex invokes this same function while
    // /recognize awaits the RecognizeText response.
    yield* LexV2.onCodeHook(alias, { localeId: "en_US" }, (event) =>
      Effect.succeed(
        LexV2.fulfillIntent(event, {
          message: `Order placed for ${event.sessionId}!`,
        }),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const sessionId = url.searchParams.get("sessionId") ?? "missing";

        if (request.method === "POST" && url.pathname === "/recognize") {
          const body = (yield* request.json) as unknown as {
            text: string;
            sessionId: string;
          };
          return yield* respond(
            recognizeText({
              localeId: "en_US",
              sessionId: body.sessionId,
              text: body.text,
            }),
            (reply) => ({
              intent: reply.sessionState?.intent?.name ?? null,
              state: reply.sessionState?.intent?.state ?? null,
              messages: (reply.messages ?? []).map((message) =>
                contentOf(message.content),
              ),
              interpretations: (reply.interpretations ?? []).map(
                (interpretation) => interpretation.intent?.name,
              ),
            }),
          );
        }

        if (request.method === "POST" && url.pathname === "/utterance") {
          const body = (yield* request.json) as unknown as {
            text: string;
            sessionId: string;
          };
          return yield* respond(
            recognizeUtterance({
              localeId: "en_US",
              sessionId: body.sessionId,
              requestContentType: "text/plain; charset=utf-8",
              // Default is speech — the test locale has no voice configured.
              responseContentType: "text/plain; charset=utf-8",
              inputStream: new TextEncoder().encode(body.text),
            }),
            (reply) => ({
              contentType: reply.contentType ?? null,
              sessionId: reply.sessionId ?? null,
            }),
          );
        }

        if (request.method === "POST" && url.pathname === "/session") {
          const body = (yield* request.json) as unknown as {
            sessionId: string;
            attributes: Record<string, string>;
          };
          return yield* respond(
            putSession({
              localeId: "en_US",
              sessionId: body.sessionId,
              sessionState: {
                dialogAction: { type: "ElicitIntent" },
                sessionAttributes: body.attributes,
              },
              // ElicitIntent requires a message to relay to the user.
              messages: [
                { contentType: "PlainText", content: "How can I help?" },
              ],
              // Default is speech — the test locale has no voice configured.
              responseContentType: "text/plain; charset=utf-8",
            }),
            (reply) => ({ sessionId: reply.sessionId ?? null }),
          );
        }

        if (request.method === "GET" && url.pathname === "/session") {
          return yield* respond(
            getSession({ localeId: "en_US", sessionId }),
            (reply) => ({
              sessionId: reply.sessionId ?? null,
              attributes: reply.sessionState?.sessionAttributes ?? {},
            }),
          );
        }

        if (request.method === "DELETE" && url.pathname === "/session") {
          return yield* respond(
            deleteSession({ localeId: "en_US", sessionId }),
            (reply) => ({ sessionId: reply.sessionId ?? null }),
          );
        }

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname: url.pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide([
      LexV2.RecognizeTextHttp,
      LexV2.RecognizeUtteranceHttp,
      LexV2.GetSessionHttp,
      LexV2.PutSessionHttp,
      LexV2.DeleteSessionHttp,
      LexV2.LambdaCodeHookEventSource,
    ]),
  ),
);
