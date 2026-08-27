import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ImageGenerationProvider = Schema.Literals(["codex", "grok"]);
export type ImageGenerationProvider = typeof ImageGenerationProvider.Type;
export const DEFAULT_IMAGE_GENERATION_PROVIDER: ImageGenerationProvider = "codex";

export const ImageGenerationAspectRatio = Schema.Literals([
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
]);
export type ImageGenerationAspectRatio = typeof ImageGenerationAspectRatio.Type;
export const DEFAULT_IMAGE_GENERATION_ASPECT_RATIO: ImageGenerationAspectRatio = "auto";

export const ImageGenerationQuality = Schema.Literals(["auto", "low", "medium", "high"]);
export type ImageGenerationQuality = typeof ImageGenerationQuality.Type;
export const DEFAULT_IMAGE_GENERATION_QUALITY: ImageGenerationQuality = "auto";

export const ImageGenerationResolution = Schema.Literals(["1k", "2k"]);
export type ImageGenerationResolution = typeof ImageGenerationResolution.Type;
export const DEFAULT_IMAGE_GENERATION_RESOLUTION: ImageGenerationResolution = "1k";

export const GROK_IMAGE_MODELS = [
  "grok-imagine-image-2.0",
  "grok-imagine-image-quality",
  "grok-imagine-image",
] as const;
export const GrokImageModel = Schema.Literals(GROK_IMAGE_MODELS);
export type GrokImageModel = typeof GrokImageModel.Type;
export const DEFAULT_GROK_IMAGE_MODEL: GrokImageModel = "grok-imagine-image-2.0";

export const DEFAULT_ENABLE_IMAGE_GENERATION = true;

export const GeneratedImageRef = Schema.Struct({
  imageId: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  filename: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  provider: ImageGenerationProvider,
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
});
export type GeneratedImageRef = typeof GeneratedImageRef.Type;

const ImagePrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(8000)).annotate({
  description: "Text description of the image to generate or edit.",
});

const ImageProviderOverride = Schema.optional(ImageGenerationProvider).annotate({
  description:
    "Image backend for this call. Omit to use Settings (Codex unless the user changed it). Pass grok only when the user explicitly asks for Grok.",
});

export const GenerateImageInput = Schema.Struct({
  prompt: ImagePrompt,
  provider: ImageProviderOverride,
  aspectRatio: Schema.optional(ImageGenerationAspectRatio).annotate({
    description:
      "Output aspect ratio. Defaults to auto so the image model picks a ratio from the prompt.",
  }),
  quality: Schema.optional(ImageGenerationQuality).annotate({
    description: "Rendering quality. Defaults to auto. Use low for drafts and high for finals.",
  }),
  resolution: Schema.optional(ImageGenerationResolution).annotate({
    description: "Output resolution. 1k is faster; 2k is the larger deliverable.",
  }),
});
export type GenerateImageInput = typeof GenerateImageInput.Type;

export const EditImageInput = Schema.Struct({
  prompt: ImagePrompt,
  imagePath: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)).annotate({
    description:
      "Absolute path to the image to edit, or a T3 image id previously returned by generate_image.",
  }),
  provider: ImageProviderOverride,
  aspectRatio: Schema.optional(ImageGenerationAspectRatio),
  quality: Schema.optional(ImageGenerationQuality),
  resolution: Schema.optional(ImageGenerationResolution),
});
export type EditImageInput = typeof EditImageInput.Type;

export const resolveImageGenerationProvider = (
  requested: ImageGenerationProvider | undefined,
  settingsProvider: ImageGenerationProvider,
): ImageGenerationProvider => requested ?? settingsProvider;

export const GenerateImageResult = Schema.Struct({
  image: GeneratedImageRef,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  revisedPrompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8000))),
});
export type GenerateImageResult = typeof GenerateImageResult.Type;

export class ImageGenerationUnavailableError extends Schema.TaggedErrorClass<ImageGenerationUnavailableError>()(
  "ImageGenerationUnavailableError",
  {
    reason: Schema.Literals([
      "disabled",
      "missing-capability",
      "provider-unavailable",
      "provider-error",
      "invalid-input",
    ]),
    detail: Schema.String,
    provider: Schema.optional(ImageGenerationProvider),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
