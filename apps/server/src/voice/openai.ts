import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { FRONT_DECISION_JSON_SCHEMA, parseFrontDecision } from "./decision.ts";
import { FrontModelError, type FrontModelSession } from "./FrontModel.ts";

/** Accepts the server's base URL (`http://host:8080/v1`) or its full chat completions URL. */
function chatCompletionsUrl(url: string) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

const ChatCompletion = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({ message: Schema.Struct({ content: Schema.String }) }),
  ),
});
const decodeChatCompletion = Schema.decodeUnknownOption(Schema.fromJsonString(ChatCompletion));

const snippet = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

/** A session on an OpenAI-compatible server that already serves the model; nothing loads here. */
export const makeOpenAiFrontSession = Effect.fn("FrontModel.openAiSession")(function* (endpoint: {
  readonly url: string;
  readonly model: string;
}) {
  const http = yield* HttpClient.HttpClient;
  const url = chatCompletionsUrl(endpoint.url);
  const decideFailure = (detail: string, cause?: unknown) =>
    new FrontModelError({ operation: "decide", detail, cause });
  const decide: FrontModelSession["decide"] = Effect.fn("FrontModel.openAiDecide")(
    function* (messages) {
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          model: endpoint.model,
          messages,
          temperature: 0,
          max_tokens: 512,
          stream: false,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "front_decision",
              strict: true,
              schema: FRONT_DECISION_JSON_SCHEMA,
            },
          },
          // llama.cpp and vLLM pass this to the chat template; a thinking model would blow the budget.
          chat_template_kwargs: { enable_thinking: false },
        }),
      );
      const response = yield* http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError((cause) => decideFailure(`${url} is unreachable.`, cause)),
      );
      const body = yield* response.text.pipe(
        Effect.mapError((cause) => decideFailure(`${url} sent an unreadable reply.`, cause)),
      );
      if (response.status < 200 || response.status >= 300)
        return yield* decideFailure(`${url} answered ${response.status}: ${snippet(body)}`);
      const completion = decodeChatCompletion(body);
      if (Option.isNone(completion))
        return yield* decideFailure(`${url} did not return a chat completion: ${snippet(body)}`);
      const content = completion.value.choices[0].message.content;
      const decision = parseFrontDecision(content);
      if (!decision)
        return yield* decideFailure(
          `Model "${endpoint.model}" ignored the decision schema; use a server that supports response_format json_schema. It said: ${snippet(content)}`,
        );
      return decision;
    },
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new FrontModelError({ operation: "decide", detail: "The model server timed out." }),
        ),
    }),
  );
  return { decide } satisfies FrontModelSession;
});
