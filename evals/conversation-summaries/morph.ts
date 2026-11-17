import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { morphConfig } from "../shared/proxy.ts";

const decodeMorphReply = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          content: Schema.optional(
            Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
          ),
        }),
      ),
    }),
  ),
);

const MORPH_ATTEMPTS = 8;

/** Morph's free Responses API, given the production prompt as OpenCode sends it: text only. */
export const morphRunner = (): TextGenerationOperations.Runner => {
  const endpoint = morphConfig();
  return (request) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const post = HttpClientRequest.post(`${endpoint.url}/responses`).pipe(
        HttpClientRequest.setHeaders(endpoint.headers),
        HttpClientRequest.bodyJson({
          model: request.modelSelection.model,
          input: [{ role: "user", content: [{ type: "input_text", text: request.prompt }] }],
          store: false,
          max_output_tokens: 8_000,
        }),
        Effect.flatMap(client.execute),
      );
      let response = yield* post;
      // Morph limits input tokens per minute and says when to come back.
      for (let attempt = 1; response.status === 429 || response.status >= 500; attempt++) {
        if (attempt >= MORPH_ATTEMPTS) break;
        const retryAfter = Number(response.headers["retry-after"]);
        yield* Effect.sleep(`${retryAfter > 0 ? Math.min(retryAfter, 60) : 2 ** attempt} seconds`);
        response = yield* post;
      }
      // The body is omitted so a credential echoed in an error never reaches the log.
      if (response.status !== 200) return yield* Effect.die(`Morph HTTP ${response.status}`);
      const reply = yield* decodeMorphReply(yield* response.text);
      const text = reply.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .join("");
      return yield* TextGenerationOperations.decodeJsonReply(request, "Morph", text);
    }).pipe(Effect.timeout("120 seconds"), Effect.orDie, Effect.provide(FetchHttpClient.layer));
};
