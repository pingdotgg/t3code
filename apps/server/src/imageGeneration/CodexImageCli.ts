// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type CodexSettings,
  type GenerateImageInput,
  ImageGenerationUnavailableError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ProcessRunner from "../processRunner.ts";
import { SAFE_IMAGE_FILE_EXTENSIONS } from "../imageMime.ts";

const IMAGE_PATH_PATTERN = /(?:^|[\s"'=])(\/[^\s"'\\]+\.(?:png|jpe?g|webp|gif))\b/gi;

export interface CodexGeneratedFile {
  readonly path: string;
}

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

const buildCodexPrompt = (input: GenerateImageInput, destinationPath: string): string => {
  const aspect = input.aspectRatio ?? "auto";
  const quality = input.quality ?? "auto";
  const resolution = input.resolution ?? "1k";
  return [
    "Use the built-in image_gen tool now. Do not write a placeholder file. Do not use OPENAI_API_KEY.",
    `Prompt: ${input.prompt}`,
    `Aspect ratio: ${aspect}.`,
    `Quality: ${quality}.`,
    `Target a ${resolution} output if the tool lets you choose size or quality.`,
    `After the image is generated, copy the resulting file to ${destinationPath}.`,
    "Reply with only that absolute path.",
  ].join(" ");
};

export const generateCodexImage = Effect.fn("CodexImageCli.generate")(function* (input: {
  readonly settings: CodexSettings;
  readonly generate: GenerateImageInput;
  readonly destinationPath: string;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = yield* resolveCodexHomeLayout(input.settings);
  const homePath = layout.effectiveHomePath ?? layout.sharedHomePath;
  const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-image-"));
  const destinationDir = path.dirname(input.destinationPath);
  yield* fileSystem.makeDirectory(destinationDir, { recursive: true }).pipe(
    Effect.mapError(
      () =>
        new ImageGenerationUnavailableError({
          reason: "provider-error",
          provider: "codex",
          detail: "Could not create the T3 Code images directory.",
        }),
    ),
  );

  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* runner
    .run({
      command: input.settings.binaryPath || "codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--enable",
        "image_generation",
        "--sandbox",
        "workspace-write",
        "--add-dir",
        destinationDir,
        "-C",
        scratchDir,
        "--json",
        buildCodexPrompt(input.generate, input.destinationPath),
      ],
      cwd: scratchDir,
      env: {
        CODEX_HOME: homePath,
      },
      timeout: Duration.minutes(5),
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 4 * 1024 * 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.mapError(
        () =>
          new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: "codex",
            detail: "Codex did not start. Check the Codex binary path in Settings.",
          }),
      ),
    );

  if (result.timedOut) {
    return yield* new ImageGenerationUnavailableError({
      reason: "provider-error",
      provider: "codex",
      detail: "Codex image generation timed out.",
    });
  }

  const generatedHome = path.join(homePath, "generated_images");
  const candidates = [
    ...(NodeFS.existsSync(input.destinationPath) ? [input.destinationPath] : []),
    ...collectImagePaths(`${result.stdout}\n${result.stderr}`),
    ...listNewImages(scratchDir, startedAt),
    ...listNewImages(generatedHome, startedAt),
  ];
  const found = candidates.find((candidate) => {
    try {
      return NodeFS.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    const preview = result.stderr.trim() || result.stdout.trim();
    return yield* new ImageGenerationUnavailableError({
      reason: "provider-error",
      provider: "codex",
      detail: preview
        ? `Codex did not save an image. ${preview.slice(0, 300)}`
        : "Codex did not save an image.",
    });
  }
  if (found !== input.destinationPath) {
    yield* fileSystem.copyFile(found, input.destinationPath).pipe(
      Effect.mapError(
        () =>
          new ImageGenerationUnavailableError({
            reason: "provider-error",
            provider: "codex",
            detail:
              "Codex generated an image but T3 Code could not copy it into the images directory.",
          }),
      ),
    );
  }
  return { path: input.destinationPath };
});
