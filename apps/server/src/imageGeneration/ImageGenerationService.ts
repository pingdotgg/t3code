import {
  CodexSettings,
  type EditImageInput,
  type GenerateImageInput,
  type GenerateImageResult,
  type GeneratedImageRef,
  ImageGenerationUnavailableError,
  resolveImageGenerationProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";
import {
  copyGeneratedImage,
  createGeneratedImageId,
  parseGeneratedImageId,
  resolveGeneratedImagePath,
  writeGeneratedImage,
} from "../imageStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { generateCodexImage } from "./CodexImageCli.ts";
import {
  editGrokImage,
  generateGrokImage,
  grokImagineOptionsFromToolInput,
} from "./GrokImagine.ts";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

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
      const httpClient = yield* HttpClient.HttpClient;
      const clock = yield* Clock.Clock;
      const runLock = yield* Semaphore.make(1);

      const persistBytes = Effect.fn("ImageGenerationService.persistBytes")(function* (input: {
        readonly bytes: Uint8Array;
        readonly mimeType: string;
        readonly provider: GeneratedImageRef["provider"];
        readonly model?: string;
      }): Effect.fn.Return<GenerateImageResult, ImageGenerationUnavailableError> {
        const extension = inferImageExtension({ mimeType: input.mimeType });
        const imageId = createGeneratedImageId(extension);
        if (!imageId) {
          return yield* new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: input.provider,
            detail: "Could not allocate an image id.",
          });
        }
        const stored = yield* Effect.try({
          try: () =>
            writeGeneratedImage({
              imagesDir: serverConfig.imagesDir,
              imageId,
              bytes: input.bytes,
            }),
          catch: () =>
            new ImageGenerationUnavailableError({
              reason: "provider-error",
              provider: input.provider,
              detail: "Could not save the generated image to the T3 Code images directory.",
            }),
        });
        if (!stored) {
          return yield* new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: input.provider,
            detail: "Could not save the generated image to the T3 Code images directory.",
          });
        }
        return {
          image: {
            imageId,
            filename: imageId,
            mimeType: input.mimeType,
            provider: input.provider,
            ...(input.model ? { model: input.model } : {}),
          },
          path: stored,
        };
      });

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
          const options = grokImagineOptionsFromToolInput(input);
          const image = yield* generateGrokImage({
            prompt: input.prompt,
            model: settings.imageGenerationGrokModel,
            aspectRatio: options.aspectRatio,
            resolution: options.resolution,
            ...(options.quality ? { quality: options.quality } : {}),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(Clock.Clock, clock),
          );
          return yield* persistBytes({
            bytes: image.bytes,
            mimeType: image.mimeType,
            provider: "grok",
            model: settings.imageGenerationGrokModel,
          });
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
        const generated = yield* generateCodexImage({
          settings: decodeCodexSettings(settings.providers.codex),
          generate: input,
          destinationPath,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          Effect.provideService(Clock.Clock, clock),
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

      const readSourceBytes = Effect.fn("ImageGenerationService.readSourceBytes")(function* (
        imagePath: string,
      ) {
        const fromLibrary = parseGeneratedImageId(imagePath)
          ? resolveGeneratedImagePath({ imagesDir: serverConfig.imagesDir, imageId: imagePath })
          : null;
        const sourcePath = fromLibrary ?? imagePath;
        return yield* fileSystem.readFile(sourcePath).pipe(
          Effect.mapError(
            () =>
              new ImageGenerationUnavailableError({
                reason: "invalid-input",
                detail: `Could not read the source image at ${imagePath}.`,
              }),
          ),
        );
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
          const source = yield* readSourceBytes(input.imagePath);
          const options = grokImagineOptionsFromToolInput(input);
          const image = yield* editGrokImage({
            prompt: input.prompt,
            model: settings.imageGenerationGrokModel,
            aspectRatio: options.aspectRatio,
            resolution: options.resolution,
            sourceImage: source,
            ...(options.quality ? { quality: options.quality } : {}),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(Clock.Clock, clock),
          );
          return yield* persistBytes({
            bytes: image.bytes,
            mimeType: image.mimeType,
            provider: "grok",
            model: settings.imageGenerationGrokModel,
          });
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

      return ImageGenerationService.of({
        generate: (input) => runLock.withPermits(1)(generate(input)),
        edit: (input) => runLock.withPermits(1)(edit(input)),
        importFile,
      });
    }),
  ).pipe(Layer.provide(ProcessRunner.layer), Layer.provide(FetchHttpClient.layer));
}
