import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  codexDefaultReasoningEffortOverride,
  mapCodexReasoningEffortDescriptor,
} from "./CodexProvider.ts";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
      default_reasoning_level: Schema.optionalKey(Schema.Unknown),
      supported_reasoning_levels: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});

const decodeReasoningLevels = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ effort: Schema.NonEmptyString })),
);

export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map((model) => {
      const native = nativeModels.find((candidate) => candidate.slug === model.slug);
      let capabilities = native?.capabilities ?? null;
      if (
        !capabilities?.optionDescriptors?.some((descriptor) => descriptor.id === "reasoningEffort")
      ) {
        const reasoningLevels = Option.getOrElse(
          decodeReasoningLevels(model.supported_reasoning_levels),
          () => [],
        );
        const defaultReasoningEffort =
          codexDefaultReasoningEffortOverride(model.slug) ??
          (typeof model.default_reasoning_level === "string"
            ? model.default_reasoning_level
            : undefined);
        const reasoningDescriptor = mapCodexReasoningEffortDescriptor({
          ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
          supportedReasoningEfforts: reasoningLevels.map((level) => ({
            reasoningEffort: level.effort,
          })),
        });
        if (reasoningDescriptor) {
          capabilities = createModelCapabilities({
            optionDescriptors: [reasoningDescriptor, ...(capabilities?.optionDescriptors ?? [])],
          });
        }
      }
      return {
        ...native,
        capabilities,
        slug: model.slug,
        name: model.display_name,
        isCustom: false,
      } satisfies ServerProviderModel;
    });
}, Effect.timeout("15 seconds"));
