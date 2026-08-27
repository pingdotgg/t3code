import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ImageGenerationService } from "../../../imageGeneration/ImageGenerationService.ts";
import { ImageGenerationToolkit } from "./tools.ts";

const handlers = {
  generate_image: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireImageGenerationCapability();
      const images = yield* ImageGenerationService;
      return yield* images.generate(input);
    }),
  edit_image: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireImageGenerationCapability();
      const images = yield* ImageGenerationService;
      return yield* images.edit(input);
    }),
} satisfies Parameters<typeof ImageGenerationToolkit.toLayer>[0];

export const ImageGenerationToolkitHandlersLive = ImageGenerationToolkit.toLayer(handlers);
