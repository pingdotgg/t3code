import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GcpProjectMissing } from "../Environment.ts";
import { bindGcpHost } from "../Host.ts";
import {
  GenerateContent,
  type GenerateContentClient,
  type GenerateContentRequest,
  type PublisherModel,
} from "./GenerateContent.ts";

const TAG = "GCP.AIPlatform.GenerateContent";

/**
 * HTTP implementation of {@link GenerateContent}.
 *
 * @layer
 * @provides GCP.AIPlatform.GenerateContent
 */
export const GenerateContentHttp = Layer.effect(
  GenerateContent,
  Effect.gen(function* () {
    const generateContent =
      yield* aiplatform.generateContentProjectsLocationsPublishersModels;
    // The project is the caller's own: deploy credentials at plan time,
    // the metadata server inside Cloud Run / Cloud Functions.
    const credentials = yield* Credentials;
    const project = credentials.pipe(
      Effect.flatMap(({ project }) =>
        project
          ? Effect.succeed(project)
          : Effect.fail(
              new GcpProjectMissing({
                message: `${TAG}: no GCP project id in the runtime credentials`,
              }),
            ),
      ),
    );

    return Effect.fn(function* (target: string | PublisherModel) {
      const {
        model,
        location = "global",
        publisher = "google",
      } = typeof target === "string" ? { model: target } : target;
      const id = `${publisher}/${model}@${location}`;

      yield* bindGcpHost({
        tag: TAG,
        resource: { LogicalId: id },
        // Publisher models have no resource IAM policy; aiplatform.user is
        // the narrowest predefined role carrying aiplatform.endpoints.predict.
        iam: [{ role: "roles/aiplatform.user" }],
      });

      const generate = Effect.fn(`${TAG}(${id})`)(function* (
        request: GenerateContentRequest,
      ) {
        return yield* generateContent({
          model: `projects/${yield* project}/locations/${location}/publishers/${publisher}/models/${model}`,
          body: request,
        });
      });

      const client: GenerateContentClient = {
        generate,
        text: (prompt, options) =>
          generate({
            ...options,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          }).pipe(
            Effect.map((response) =>
              (response.candidates?.[0]?.content?.parts ?? [])
                .filter((part) => !part.thought)
                .map((part) => part.text ?? "")
                .join(""),
            ),
          ),
      };
      return client;
    });
  }),
);
