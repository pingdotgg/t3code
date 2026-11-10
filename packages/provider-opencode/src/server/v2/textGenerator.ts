import { Model, Provider } from "@opencode/client/effect";
import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";

export const make = Effect.fn("OpenCodeTextGenerator.make")(function* () {
  const server = yield* OpenCode2Server.OpenCode2Server;
  return Effect.fn("OpenCodeTextGenerator.generate")(function* (
    input: Parameters<NonNullable<ProviderInstance["generateText"]>>[0],
  ) {
    const parsed = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (parsed === null) {
      return yield* new TextGenerationError({
        operation: "generateText",
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }
    const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
    const result = yield* server
      .withConnection(({ client }) =>
        client.generate.text({
          prompt: input.prompt,
          model: Model.Ref.make({
            providerID: Provider.ID.make(parsed.providerID),
            id: Model.ID.make(parsed.modelID),
            ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
          }),
        }),
      )
      .pipe(
        Effect.timeout("2 minutes"),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateText",
              detail:
                "OpenCode raw text generation failed. Check that the selected model and account support raw generation.",
              cause,
            }),
        ),
      );
    const text = result.text.trim();
    if (text.length === 0)
      return yield* new TextGenerationError({
        operation: "generateText",
        detail: "OpenCode returned no text.",
      });
    return text;
  });
});
