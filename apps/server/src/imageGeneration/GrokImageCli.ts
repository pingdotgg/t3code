// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type EditImageInput,
  type GenerateImageInput,
  type GrokImageModel,
  type GrokSettings,
  ImageGenerationUnavailableError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SAFE_IMAGE_FILE_EXTENSIONS } from "../imageMime.ts";
import * as ProcessRunner from "../processRunner.ts";

const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const IMAGE_PATH_PATTERN = /(?:^|[\s"'=])(\/[^\s"'\\]+\.(?:png|jpe?g|webp|gif))\b/gi;
const GROK_IMAGE_TIMEOUT = Duration.minutes(5);

export interface GrokGeneratedFile {
  readonly path: string;
}

export const grokImagineOptionsFromToolInput = (
  input: GenerateImageInput | EditImageInput,
): { aspectRatio: string; resolution: "1k" | "2k"; quality?: "low" | "medium" | "high" } => {
  const quality =
    input.quality && input.quality !== "auto"
      ? input.quality === "high"
        ? "medium"
        : input.quality
      : undefined;
  return {
    aspectRatio: input.aspectRatio ?? "auto",
    resolution: input.resolution ?? "1k",
    ...(quality ? { quality } : {}),
  };
};

const collectImagePaths = (text: string): string[] => {
  const matches: string[] = [];
  for (const match of text.matchAll(IMAGE_PATH_PATTERN)) {
    const value = match[1];
    if (value) matches.push(value);
  }
  return matches;
};

const listNewImages = (directory: string, sinceMs: number): string[] => {
  try {
    return NodeFS.readdirSync(directory)
      .filter((name) => SAFE_IMAGE_FILE_EXTENSIONS.has(NodePath.extname(name).toLowerCase()))
      .map((name) => NodePath.join(directory, name))
      .filter((filePath) => {
        try {
          const stat = NodeFS.statSync(filePath);
          return stat.isFile() && stat.mtimeMs >= sinceMs - 2_000;
        } catch {
          return false;
        }
      })
      .sort((left, right) => NodeFS.statSync(right).mtimeMs - NodeFS.statSync(left).mtimeMs);
  } catch {
    return [];
  }
};

const listNewGrokSessionImages = (sinceMs: number): string[] => {
  const sessionsRoot = NodePath.join(NodeOS.homedir(), ".grok", "sessions");
  try {
    const sessionDirs = NodeFS.readdirSync(sessionsRoot)
      .map((name) => NodePath.join(sessionsRoot, name, "images"))
      .slice(-80);
    return sessionDirs.flatMap((directory) => listNewImages(directory, sinceMs));
  } catch {
    return [];
  }
};

const firstExistingFile = (candidates: ReadonlyArray<string>): string | undefined =>
  candidates.find((candidate) => {
    try {
      return NodeFS.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

const buildGrokPrompt = (input: {
  readonly prompt: string;
  readonly destinationPath: string;
  readonly model: GrokImageModel;
  readonly aspectRatio: string;
  readonly resolution: "1k" | "2k";
  readonly quality?: "low" | "medium" | "high";
  readonly sourcePath?: string;
}): string => {
  const quality = input.quality ?? "auto";
  const editLine = input.sourcePath
    ? `Use the built-in image_edit tool now on ${input.sourcePath}.`
    : "Use the built-in image_gen tool now.";
  return [
    editLine,
    "Do not write a placeholder file. Do not call an HTTP API or curl.",
    `Prompt: ${input.prompt}`,
    `Prefer model ${input.model} if the tool lets you choose.`,
    `Aspect ratio: ${input.aspectRatio}.`,
    `Quality: ${quality}.`,
    `Target a ${input.resolution} output if the tool lets you choose size or quality.`,
    `After the image is generated, copy the resulting file to ${input.destinationPath}.`,
    "Reply with only that absolute path.",
  ].join(" ");
};

const runGrokImage = Effect.fn("GrokImageCli.run")(function* (input: {
  readonly settings: GrokSettings;
  readonly prompt: string;
  readonly destinationPath: string;
  readonly extraSearchDirs?: ReadonlyArray<string>;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-grok-image-"));
  const destinationDir = path.dirname(input.destinationPath);
  yield* fileSystem.makeDirectory(destinationDir, { recursive: true }).pipe(
    Effect.mapError(
      () =>
        new ImageGenerationUnavailableError({
          reason: "provider-error",
          provider: "grok",
          detail: "Could not create the T3 Code images directory.",
        }),
    ),
  );

  yield* Effect.logInfo("Grok image generation started");
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* runner
    .run({
      command: input.settings.binaryPath || "grok",
      args: [
        "--always-approve",
        "--permission-mode",
        "bypassPermissions",
        "--output-format",
        "json",
        "--cwd",
        scratchDir,
        "-p",
        input.prompt,
      ],
      cwd: scratchDir,
      env: {
        [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
      },
      timeout: GROK_IMAGE_TIMEOUT,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 4 * 1024 * 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.mapError(
        () =>
          new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: "grok",
            detail: "Grok did not start. Check the Grok binary path in Settings.",
          }),
      ),
    );

  if (result.timedOut) {
    return yield* new ImageGenerationUnavailableError({
      reason: "provider-error",
      provider: "grok",
      detail: "Grok image generation timed out after 5 minutes.",
    });
  }

  const candidates = [
    ...(NodeFS.existsSync(input.destinationPath) ? [input.destinationPath] : []),
    ...collectImagePaths(`${result.stdout}\n${result.stderr}`),
    ...listNewImages(scratchDir, startedAt),
    ...listNewGrokSessionImages(startedAt),
    ...(input.extraSearchDirs ?? []).flatMap((directory) => listNewImages(directory, startedAt)),
  ];
  const found = firstExistingFile(candidates);
  if (!found) {
    const preview = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
    return yield* new ImageGenerationUnavailableError({
      reason: "provider-error",
      provider: "grok",
      detail: preview ? `Grok did not save an image. ${preview}` : "Grok did not save an image.",
    });
  }
  if (found !== input.destinationPath) {
    yield* fileSystem.copyFile(found, input.destinationPath).pipe(
      Effect.mapError(
        () =>
          new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: "grok",
            detail:
              "Grok generated an image but T3 Code could not copy it into the images directory.",
          }),
      ),
    );
  }
  return { path: input.destinationPath } satisfies GrokGeneratedFile;
});

export const generateGrokImage = Effect.fn("GrokImageCli.generate")(function* (input: {
  readonly settings: GrokSettings;
  readonly generate: GenerateImageInput;
  readonly destinationPath: string;
  readonly model: GrokImageModel;
}) {
  const options = grokImagineOptionsFromToolInput(input.generate);
  return yield* runGrokImage({
    settings: input.settings,
    destinationPath: input.destinationPath,
    prompt: buildGrokPrompt({
      prompt: input.generate.prompt,
      destinationPath: input.destinationPath,
      model: input.model,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      ...(options.quality ? { quality: options.quality } : {}),
    }),
  });
});

export const editGrokImage = Effect.fn("GrokImageCli.edit")(function* (input: {
  readonly settings: GrokSettings;
  readonly edit: EditImageInput;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly model: GrokImageModel;
}) {
  const options = grokImagineOptionsFromToolInput(input.edit);
  return yield* runGrokImage({
    settings: input.settings,
    destinationPath: input.destinationPath,
    extraSearchDirs: [NodePath.dirname(input.sourcePath)],
    prompt: buildGrokPrompt({
      prompt: input.edit.prompt,
      destinationPath: input.destinationPath,
      model: input.model,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      sourcePath: input.sourcePath,
      ...(options.quality ? { quality: options.quality } : {}),
    }),
  });
});
