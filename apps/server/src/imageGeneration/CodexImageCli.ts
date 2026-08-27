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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ProcessRunner from "../processRunner.ts";
import { SAFE_IMAGE_FILE_EXTENSIONS } from "../imageMime.ts";

const IMAGE_PATH_PATTERN = /(?:^|[\s"'=])(\/[^\s"'\\]+\.(?:png|jpe?g|webp|gif))\b/gi;
const CODEX_IMAGE_TIMEOUT = Duration.minutes(3);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const summarizeCodexExecOutput = (stdout: string, stderr: string): string => {
  let lastMessage: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const parsed = decodeJsonUnknown(trimmed);
    if (Option.isNone(parsed)) continue;
    const record = asRecord(parsed.value);
    if (!record) continue;
    const item = asRecord(record.item);
    const fromItem =
      asTrimmedString(item?.text) ??
      asTrimmedString(item?.message) ??
      asTrimmedString(asRecord(item?.error)?.message);
    const fromEvent =
      asTrimmedString(record.message) ??
      asTrimmedString(record.error) ??
      asTrimmedString(asRecord(record.error)?.message);
    lastMessage = fromItem ?? fromEvent ?? lastMessage;
  }
  const fallback = stderr.trim() || stdout.trim();
  const preview = lastMessage ?? fallback;
  return preview.slice(0, 300);
};

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

  yield* Effect.logInfo("Codex image generation started");
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
        // Isolated tmp workspace: image_gen needs network, and a non-interactive
        // exec otherwise sits on an approval prompt until the process timeout.
        "--dangerously-bypass-approvals-and-sandbox",
        "--add-dir",
        destinationDir,
        "-C",
        scratchDir,
        "--color",
        "never",
        "--json",
        buildCodexPrompt(input.generate, input.destinationPath),
      ],
      cwd: scratchDir,
      env: {
        CODEX_HOME: homePath,
      },
      timeout: CODEX_IMAGE_TIMEOUT,
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
      detail: "Codex image generation timed out after 3 minutes.",
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
    const preview = summarizeCodexExecOutput(result.stdout, result.stderr);
    return yield* new ImageGenerationUnavailableError({
      reason: "provider-error",
      provider: "codex",
      detail: preview ? `Codex did not save an image. ${preview}` : "Codex did not save an image.",
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
