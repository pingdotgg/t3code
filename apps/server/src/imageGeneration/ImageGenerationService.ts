import {
  CodexSettings,
  GrokSettings,
  type EditImageInput,
  type GenerateImageInput,
  type GenerateImageResult,
  type GeneratedImageRef,
  ImageGenerationUnavailableError,
  resolveImageGenerationProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import {
  copyGeneratedImage,
  createGeneratedImageId,
  parseGeneratedImageId,
  resolveGeneratedImagePath,
} from "../imageStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { generateCodexImage } from "./CodexImageCli.ts";
import { editGrokImage, generateGrokImage } from "./GrokImageCli.ts";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeGrokSettings = Schema.decodeUnknownSync(GrokSettings);

export interface ImageGenerationServiceShape {
  readonly generate: (
    input: GenerateImageInput,
  ) => Effect.Effect<GenerateImageResult, ImageGenerationUnavailableError>;
  readonly edit: (
    input: EditImageInput,
  ) => Effect.Effect<GenerateImageResult, ImageGenerationUnavailableError>;
  readonly importFile: (
    sourcePath: string,
    provider: GeneratedImageRef["provider"],
    model?: string,
  ) => Effect.Effect<GenerateImageResult, ImageGenerationUnavailableError>;
}

export class ImageGenerationService extends Context.Service<
  ImageGenerationService,
  ImageGenerationServiceShape
>()("t3/imageGeneration/ImageGenerationService") {
  static readonly layer = Layer.effect(
    ImageGenerationService,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const settingsService = yield* ServerSettingsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processRunner = yield* ProcessRunner.ProcessRunner;
      const clock = yield* Clock.Clock;
      const runLock = yield* Semaphore.make(1);

      const requireEnabled = Effect.fn("ImageGenerationService.requireEnabled")(function* () {
        const settings = yield* settingsService.getSettings.pipe(
          Effect.mapError(
            () =>
              new ImageGenerationUnavailableError({
                reason: "disabled",
                detail: "Could not read image generation settings.",
              }),
          ),
        );
        if (!settings.enableImageGeneration) {
          return yield* new ImageGenerationUnavailableError({
            reason: "disabled",
            detail: "Image generation is turned off in Settings → Integrations.",
          });
        }
        return settings;
      });

      const generate: ImageGenerationServiceShape["generate"] = Effect.fn(
        "ImageGenerationService.generate",
      )(function* (input) {
        const settings = yield* requireEnabled();
        const provider = resolveImageGenerationProvider(
          input.provider,
          settings.imageGenerationProvider,
        );
        if (provider === "grok") {
          const imageId = createGeneratedImageId(".jpg");
          if (!imageId) {
            return yield* new ImageGenerationUnavailableError({
              reason: "provider-error",
              provider: "grok",
              detail: "Could not allocate an image id.",
            });
          }
          const destinationPath = resolveGeneratedImagePath({
            imagesDir: serverConfig.imagesDir,
            imageId,
          });
          if (!destinationPath) {
            return yield* new ImageGenerationUnavailableError({
              reason: "provider-error",
              provider: "grok",
              detail: "Could not resolve the T3 Code images directory.",
            });
          }
          const generated = yield* runLock.withPermits(1)(
            generateGrokImage({
              settings: decodeGrokSettings(settings.providers.grok),
              generate: input,
              destinationPath,
              model: settings.imageGenerationGrokModel,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
              Effect.provideService(Clock.Clock, clock),
              Effect.timeout(Duration.minutes(5)),
              Effect.mapError((cause) =>
                cause._tag === "TimeoutError"
                  ? new ImageGenerationUnavailableError({
                      reason: "provider-error",
                      provider: "grok",
                      detail: "Grok image generation timed out after 5 minutes.",
                    })
                  : cause._tag === "ImageGenerationUnavailableError"
                    ? cause
                    : new ImageGenerationUnavailableError({
                        reason: "provider-error",
                        provider: "grok",
                        detail: "Grok did not start. Check the Grok binary path in Settings.",
                      }),
              ),
            ),
          );
          return {
            image: {
              imageId,
              filename: imageId,
              mimeType: "image/jpeg",
              provider: "grok",
              model: settings.imageGenerationGrokModel,
            },
            path: generated.path,
          };
        }

        const imageId = createGeneratedImageId(".png");
        if (!imageId) {
          return yield* new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: "codex",
            detail: "Could not allocate an image id.",
          });
        }
        const destinationPath = resolveGeneratedImagePath({
          imagesDir: serverConfig.imagesDir,
          imageId,
        });
        if (!destinationPath) {
          return yield* new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: "codex",
            detail: "Could not resolve the T3 Code images directory.",
          });
        }
        const generated = yield* runLock.withPermits(1)(
          generateCodexImage({
            settings: decodeCodexSettings(settings.providers.codex),
            generate: input,
            destinationPath,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
            Effect.provideService(Clock.Clock, clock),
            Effect.timeout(Duration.minutes(3)),
            Effect.mapError((cause) =>
              cause._tag === "TimeoutError"
                ? new ImageGenerationUnavailableError({
                    reason: "provider-error",
                    provider: "codex",
                    detail: "Codex image generation timed out after 3 minutes.",
                  })
                : cause._tag === "ImageGenerationUnavailableError"
                  ? cause
                  : new ImageGenerationUnavailableError({
                      reason: "provider-error",
                      provider: "codex",
                      detail: "Codex did not start. Check the Codex binary path in Settings.",
                    }),
            ),
          ),
        );
        return {
          image: {
            imageId,
            filename: imageId,
            mimeType: "image/png",
            provider: "codex",
          },
          path: generated.path,
        };
      });

      const edit: ImageGenerationServiceShape["edit"] = Effect.fn("ImageGenerationService.edit")(
        function* (input) {
          const settings = yield* requireEnabled();
          const provider = resolveImageGenerationProvider(
            input.provider,
            settings.imageGenerationProvider,
          );
          if (provider !== "grok") {
            return yield* new ImageGenerationUnavailableError({
              reason: "provider-unavailable",
              provider: "codex",
              detail:
                "Image editing is available with Grok. Ask to edit with Grok, switch the provider in Settings → Integrations, or generate a new image.",
            });
          }
          const sourcePath = parseGeneratedImageId(input.imagePath)
            ? resolveGeneratedImagePath({
                imagesDir: serverConfig.imagesDir,
                imageId: input.imagePath,
              })
            : input.imagePath;
          if (!sourcePath) {
            return yield* new ImageGenerationUnavailableError({
              reason: "invalid-input",
              detail: `Could not read the source image at ${input.imagePath}.`,
            });
          }
          const imageId = createGeneratedImageId(".jpg");
          if (!imageId) {
            return yield* new ImageGenerationUnavailableError({
              reason: "provider-error",
              provider: "grok",
              detail: "Could not allocate an image id.",
            });
          }
          const destinationPath = resolveGeneratedImagePath({
            imagesDir: serverConfig.imagesDir,
            imageId,
          });
          if (!destinationPath) {
            return yield* new ImageGenerationUnavailableError({
              reason: "provider-error",
              provider: "grok",
              detail: "Could not resolve the T3 Code images directory.",
            });
          }
          const generated = yield* runLock.withPermits(1)(
            editGrokImage({
              settings: decodeGrokSettings(settings.providers.grok),
              edit: input,
              sourcePath,
              destinationPath,
              model: settings.imageGenerationGrokModel,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
              Effect.provideService(Clock.Clock, clock),
              Effect.timeout(Duration.minutes(5)),
              Effect.mapError((cause) =>
                cause._tag === "TimeoutError"
                  ? new ImageGenerationUnavailableError({
                      reason: "provider-error",
                      provider: "grok",
                      detail: "Grok image editing timed out after 5 minutes.",
                    })
                  : cause._tag === "ImageGenerationUnavailableError"
                    ? cause
                    : new ImageGenerationUnavailableError({
                        reason: "provider-error",
                        provider: "grok",
                        detail: "Grok did not start. Check the Grok binary path in Settings.",
                      }),
              ),
            ),
          );
          return {
            image: {
              imageId,
              filename: imageId,
              mimeType: "image/jpeg",
              provider: "grok",
              model: settings.imageGenerationGrokModel,
            },
            path: generated.path,
          };
        },
      );

      const importFile: ImageGenerationServiceShape["importFile"] = Effect.fn(
        "ImageGenerationService.importFile",
      )(function* (sourcePath, provider, model) {
        const extension = path.extname(sourcePath) || ".jpg";
        const imageId = createGeneratedImageId(extension);
        if (!imageId) {
          return yield* new ImageGenerationUnavailableError({
            reason: "invalid-input",
            detail: "That file is not a supported image.",
          });
        }
        const stored = yield* Effect.try({
          try: () =>
            copyGeneratedImage({
              imagesDir: serverConfig.imagesDir,
              imageId,
              sourcePath,
            }),
          catch: () =>
            new ImageGenerationUnavailableError({
              reason: "provider-error",
              provider,
              detail: "Could not copy the generated image into the T3 Code images directory.",
            }),
        });
        if (!stored) {
          return yield* new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider,
            detail: "Could not copy the generated image into the T3 Code images directory.",
          });
        }
        return {
          image: {
            imageId,
            filename: imageId,
            mimeType: extension === ".png" ? "image/png" : "image/jpeg",
            provider,
            ...(model ? { model } : {}),
          },
          path: stored,
        };
      });

      return ImageGenerationService.of({ generate, edit, importFile });
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));
}
