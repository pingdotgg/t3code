import * as Neon from "@/Neon";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { languageModelGateway } from "./language-model-resources.ts";

const Sum = Tool.make("sum", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
});
const Tools = Toolkit.make(Sum);
const handlers = Tools.toLayer({ sum: ({ a, b }) => Effect.succeed(a + b) });

export const languageModelHandler = (source = languageModelGateway) =>
  Effect.gen(function* () {
    const gateway = yield* Neon.QueryAIGateway(source);
    const model = Layer.unwrap(
      Config.String("AI_MODEL").pipe(
        Effect.map((model) => gateway.model({ model })),
      ),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/object")) {
          const response = yield* LanguageModel.generateObject({
            prompt: "Return a JSON object with greeting equal to hello.",
            schema: Schema.Struct({ greeting: Schema.String }),
          });
          return yield* HttpServerResponse.json(response.value);
        }
        if (request.url.startsWith("/tool")) {
          const response = yield* LanguageModel.generateText({
            prompt: "Use sum to add 2 and 3.",
            toolkit: Tools,
            toolChoice: { tool: "sum" },
          }).pipe(Effect.provide(handlers));
          return yield* HttpServerResponse.json({
            results: response.toolResults.map((part) => part.result),
          });
        }
        if (request.url.startsWith("/stream")) {
          const parts = yield* LanguageModel.streamText({
            prompt: "Say hello.",
          }).pipe(Stream.runCollect);
          return yield* HttpServerResponse.json({
            text: parts
              .filter((part) => part.type === "text-delta")
              .map((part) => part.delta)
              .join(""),
            finished: parts.some((part) => part.type === "finish"),
          });
        }
        const response = yield* LanguageModel.generateText({
          prompt: "Say hello.",
        });
        return yield* HttpServerResponse.json({ text: response.text });
      }).pipe(
        Effect.provide(model),
        Effect.catchTag("AiError", (error) =>
          HttpServerResponse.json(
            { reason: error.reason._tag },
            { status: 502 },
          ),
        ),
        Effect.orDie,
      ),
    };
  });
