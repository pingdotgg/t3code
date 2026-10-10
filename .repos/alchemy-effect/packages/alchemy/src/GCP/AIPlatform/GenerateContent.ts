import type * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { GcpProjectMissing } from "../Environment.ts";

/**
 * A Vertex AI publisher model, e.g. Gemini. Publisher models are not
 * Alchemy resources — they are addressed by id under a location.
 */
export interface PublisherModel {
  /**
   * Model id, e.g. `gemini-2.5-flash`.
   */
  model: string;
  /**
   * Vertex AI location serving the model. `global` routes to any region
   * with capacity; pin a region (e.g. `us-central1`) for data residency.
   * @default "global"
   */
  location?: string;
  /**
   * Model publisher.
   * @default "google"
   */
  publisher?: string;
}

export interface GenerateContentRequest
  extends aiplatform.GoogleCloudAiplatformV1GenerateContentRequest {}

export type GenerateContentError =
  | aiplatform.GenerateContentProjectsLocationsPublishersModelsError
  | GcpProjectMissing;

/**
 * Runtime client returned by {@link GenerateContent}.
 */
export interface GenerateContentClient {
  /**
   * Full `generateContent` call against the bound model.
   */
  generate(
    request: GenerateContentRequest,
  ): Effect.Effect<
    aiplatform.GoogleCloudAiplatformV1GenerateContentResponse,
    GenerateContentError,
    RuntimeContext
  >;
  /**
   * Single-turn text generation: sends `prompt` as one user turn and
   * returns the concatenated text parts of the first candidate.
   * `options` is merged into the request (generation config, system
   * instruction, safety settings, ...).
   */
  text(
    prompt: string,
    options?: Omit<GenerateContentRequest, "contents">,
  ): Effect.Effect<string, GenerateContentError, RuntimeContext>;
}

/**
 * Runtime binding for Vertex AI `generateContent` on a publisher model
 * (Gemini).
 *
 * Bind it in a Function/Job init phase with a model id or a
 * {@link PublisherModel} descriptor and provide
 * {@link GenerateContentHttp}. At deploy time it grants the host's
 * runtime service account `roles/aiplatform.user` on the project —
 * Vertex AI publisher models have no resource-level IAM policy.
 *
 * ### Generating Text
 * **Example:** Ask Gemini a question
 * ```typescript
 * const gemini = yield* GCP.AIPlatform.GenerateContent("gemini-2.5-flash");
 * const answer = yield* gemini.text("Name three primary colors.");
 * ```
 *
 * **Example:** Pin a region and tune generation
 * ```typescript
 * const gemini = yield* GCP.AIPlatform.GenerateContent({
 *   model: "gemini-2.5-flash",
 *   location: "us-central1",
 * });
 * const answer = yield* gemini.text("Write a haiku about rain.", {
 *   generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
 * });
 * ```
 *
 * ### Full Requests
 * **Example:** Multi-turn chat with a system instruction
 * ```typescript
 * const response = yield* gemini.generate({
 *   systemInstruction: { parts: [{ text: "Answer in one sentence." }] },
 *   contents: [
 *     { role: "user", parts: [{ text: "What is Cloud Run?" }] },
 *     { role: "model", parts: [{ text: "A serverless container platform." }] },
 *     { role: "user", parts: [{ text: "How is it billed?" }] },
 *   ],
 * });
 * const usage = response.usageMetadata?.totalTokenCount;
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface GenerateContent extends Binding.Service<
  GenerateContent,
  "GCP.AIPlatform.GenerateContent",
  (model: string | PublisherModel) => Effect.Effect<GenerateContentClient>
> {}

export const GenerateContent = Binding.Service<GenerateContent>(
  "GCP.AIPlatform.GenerateContent",
);
