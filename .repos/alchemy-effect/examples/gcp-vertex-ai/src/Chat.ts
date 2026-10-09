import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// Gemini 2.5 Flash on the `global` endpoint — cheap, fast, and routed to
// any region with capacity. Any Gemini model id works here; pass
// `{ model, location: "us-central1" }` to pin a region instead.
const MODEL = "gemini-2.5-flash";

interface ChatRequest {
  prompt?: string;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * A public chat endpoint on Cloud Run that answers with Gemini on
 * Vertex AI.
 *
 * - `GET /` — health check.
 * - `POST /chat` — `{ prompt, system?, temperature?, maxOutputTokens? }`
 *   in, `{ text, finishReason, modelVersion, usage }` out.
 *
 * There is no API key anywhere: the container calls Vertex AI as its own
 * runtime service account, which the binding grants
 * `roles/aiplatform.user` at deploy time.
 *
 * `invokerIamDisabled: true` makes the service publicly reachable. Drop it
 * and Cloud Run requires a signed Google identity token on every request —
 * worth doing before this endpoint spends real money on strangers' prompts.
 */
export default class Chat extends GCP.Function<Chat>()(
  "Chat",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    // Init: bind the model. Grants the runtime service account
    // roles/aiplatform.user and returns a typed Gemini client.
    const gemini = yield* GCP.AIPlatform.GenerateContent(MODEL);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method !== "POST" || url.pathname !== "/chat") {
          return yield* HttpServerResponse.json(
            { error: "not found" },
            { status: 404 },
          );
        }

        const body = (yield* request.json) as ChatRequest;
        if (!body.prompt) {
          return yield* HttpServerResponse.json(
            { error: "prompt is required" },
            { status: 400 },
          );
        }

        // Model access is bound at deploy time; generation settings are a
        // per-request decision.
        const response = yield* gemini.generate({
          contents: [{ role: "user", parts: [{ text: body.prompt }] }],
          ...(body.system
            ? { systemInstruction: { parts: [{ text: body.system }] } }
            : {}),
          generationConfig: {
            ...(body.temperature !== undefined
              ? { temperature: body.temperature }
              : {}),
            ...(body.maxOutputTokens !== undefined
              ? { maxOutputTokens: body.maxOutputTokens }
              : {}),
          },
        });

        const candidate = response.candidates?.[0];
        return yield* HttpServerResponse.json({
          // Gemini 2.5 may return "thought" parts; answer with the rest.
          text: (candidate?.content?.parts ?? [])
            .filter((part) => !part.thought)
            .map((part) => part.text ?? "")
            .join(""),
          finishReason: candidate?.finishReason,
          modelVersion: response.modelVersion,
          usage: {
            inputTokens: response.usageMetadata?.promptTokenCount,
            outputTokens: response.usageMetadata?.candidatesTokenCount,
          },
        });
      }).pipe(
        // A blocked prompt or bad generation config is the caller's
        // problem; surface Vertex AI's message instead of a bare 500.
        Effect.catchTag("BadRequest", (error) =>
          HttpServerResponse.json({ error: error.message }, { status: 400 }),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(Effect.provide(GCP.AIPlatform.GenerateContentHttp)),
) {}
