import { ImageGenerationUnavailableError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ImageGenerationService } from "../../../imageGeneration/ImageGenerationService.ts";
import { ImageGenerationToolkit } from "./tools.ts";

// Keep this under Grok's HTTP MCP override (10 minutes in GrokAdapter _meta)
// so the JSON-RPC result always arrives instead of "Timed out. Retry."
const IMAGE_MCP_DEADLINE = Duration.minutes(9);

const runImageTool = <A>(
  effect: Effect.Effect<
    A,
    ImageGenerationUnavailableError,
    ImageGenerationService | McpInvocationContext.McpInvocationContext
  >,
) =>
  effect.pipe(
    Effect.timeout(IMAGE_MCP_DEADLINE),
    Effect.mapError((cause) =>
      cause._tag === "TimeoutError"
        ? new ImageGenerationUnavailableError({
            reason: "provider-error",
            detail: "Image generation took too long.",
          })
        : cause,
    ),
  );

const handlers = {
  generate_image: (input) =>
    runImageTool(
      Effect.gen(function* () {
        yield* McpInvocationContext.requireImageGenerationCapability();
        const images = yield* ImageGenerationService;
        return yield* images.generate(input);
      }),
    ),
  edit_image: (input) =>
    runImageTool(
      Effect.gen(function* () {
        yield* McpInvocationContext.requireImageGenerationCapability();
        const images = yield* ImageGenerationService;
        return yield* images.edit(input);
      }),
    ),
} satisfies Parameters<typeof ImageGenerationToolkit.toLayer>[0];

export const ImageGenerationToolkitHandlersLive = ImageGenerationToolkit.toLayer(handlers);
