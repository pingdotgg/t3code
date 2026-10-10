import * as Neon from "alchemy/Neon";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Sse from "effect/encoding/Sse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { resources } from "../resources.ts";
import { gateway } from "./resources.ts";

/** Authenticated, opt-in text streaming backed by the bound Effect model. */
export const chat = (
  ai: Pick<Neon.QueryAIGatewayClient, "model">,
  environment: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (
      !environment.NEON_EXAMPLE_API_KEY ||
      request.headers.authorization !==
        `Bearer ${environment.NEON_EXAMPLE_API_KEY}`
    ) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const body = yield* request.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ prompt: Schema.String })),
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (!body)
      return HttpServerResponse.text("A JSON prompt is required", {
        status: 400,
      });
    if (body.prompt.trim().length === 0 || body.prompt.length > 4000) {
      return HttpServerResponse.text(
        "Expected a nonempty prompt of at most 4000 characters",
        { status: 400 },
      );
    }
    if (
      environment.NEON_AI_ALLOW_PAID !== "true" ||
      !environment.NEON_AI_MODEL
    ) {
      return HttpServerResponse.text(
        "Explicit paid inference opt-in and a configured model are required",
        { status: 503 },
      );
    }

    const native = yield* Neon.FunctionRequest;
    const model = ai.model({
      model: environment.NEON_AI_MODEL,
      parameters: { maxTokens: 128 },
    });
    // The response body is consumed after the handler returns, in the transferred request scope.
    const context = yield* Effect.context<RuntimeContext | Scope.Scope>();
    const events = LanguageModel.streamText({ prompt: body.prompt }).pipe(
      Stream.flatMap((part): Stream.Stream<Record<string, unknown>> => {
        switch (part.type) {
          case "text-start":
          case "text-end":
            return Stream.succeed({ type: part.type, id: part.id });
          case "text-delta":
            return Stream.succeed({
              type: "text-delta",
              id: part.id,
              delta: part.delta,
            });
          case "finish":
            return Stream.make(
              { type: "finish-step" },
              { type: "finish", finishReason: part.reason },
            );
          default:
            return Stream.empty;
        }
      }),
      Stream.provide(model),
      Stream.provideContext(context),
      Stream.catchTag("AiError", () =>
        Stream.succeed({
          type: "error",
          errorText:
            "Gateway rejected the request. Check model access, paid-plan entitlement and prepaid credits. No credits were purchased.",
        }),
      ),
    );
    const stream = Stream.concat(
      Stream.make({ type: "start" }, { type: "start-step" }),
      events,
    ).pipe(
      Stream.map((event) => JSON.stringify(event)),
      Stream.concat(Stream.succeed("[DONE]")),
      Stream.map((data): Sse.Event => ({
        _tag: "Event",
        event: "message",
        id: undefined,
        data,
      })),
      Stream.pipeThroughChannel(Sse.encode<never, unknown>()),
      Stream.encodeText,
      Stream.interruptWhen(
        Effect.callback<void>((resume) => {
          const abort = () => resume(Effect.void);
          if (native.signal.aborted) abort();
          else native.signal.addEventListener("abort", abort, { once: true });
          return Effect.sync(() =>
            native.signal.removeEventListener("abort", abort),
          );
        }),
      ),
    );
    return HttpServerResponse.stream(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    });
  });

export default class EffectApi extends Neon.Function<EffectApi>()(
  "EffectAI",
  Effect.gen(function* () {
    return {
      branch: (yield* resources).branch,
      main: import.meta.url,
      env: {
        NEON_EXAMPLE_API_KEY: yield* Config.Redacted("NEON_EXAMPLE_API_KEY"),
        NEON_AI_MODEL: yield* Config.String("NEON_AI_MODEL"),
        NEON_AI_ALLOW_PAID: yield* Config.String("NEON_AI_ALLOW_PAID").pipe(
          Config.withDefault("false"),
        ),
      },
    };
  }),
  Effect.gen(function* () {
    const ai = yield* Neon.QueryAIGateway(gateway);
    const environment = yield* Neon.FunctionEnvironment;
    return { fetch: chat(ai, environment) };
  }).pipe(Effect.provide(Neon.QueryAIGatewayHttp)),
) {}
