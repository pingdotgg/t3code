import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "../Errors.ts";
import { inferImageExtension, parseBase64DataUrl } from "../../imageMime.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const CODEX_MODEL = "gpt-5.3-codex";
const CODEX_REASONING_EFFORT = "low";
const CODEX_TIMEOUT_MS = 180_000;

const COMMIT_OUTPUT_SCHEMA_JSON = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

const PR_OUTPUT_SCHEMA_JSON = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

const BRANCH_NAME_OUTPUT_SCHEMA_JSON = {
  type: "object",
  properties: {
    branch: { type: "string" },
  },
  required: ["branch"],
  additionalProperties: false,
} as const;

function normalizeCodexError(
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes("Command not found: codex") ||
      lower.includes("spawn codex") ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: "Codex CLI (`codex`) is required but not available on PATH.",
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

function parseCommitOutput(raw: unknown): { subject: string; body: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("Codex returned a non-object commit message payload.");
  }
  const record = raw as Record<string, unknown>;
  const subject = typeof record.subject === "string" ? record.subject.trim() : "";
  const body = typeof record.body === "string" ? record.body : "";
  if (subject.length === 0) {
    throw new Error("Codex returned an empty commit subject.");
  }
  return { subject, body };
}

function parsePrOutput(raw: unknown): { title: string; body: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("Codex returned a non-object PR payload.");
  }
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (title.length === 0 || body.length === 0) {
    throw new Error("Codex returned an invalid PR title/body payload.");
  }
  return { title, body };
}

function parseBranchNameOutput(raw: unknown): { branch: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("Codex returned a non-object branch payload.");
  }
  const record = raw as Record<string, unknown>;
  const branch = typeof record.branch === "string" ? record.branch.trim() : "";
  if (branch.length === 0) {
    throw new Error("Codex returned an empty branch name payload.");
  }
  return { branch };
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

function sanitizeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

const makeCodexTextGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      let text = "";
      yield* Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => {
          text += Buffer.from(chunk).toString("utf8");
        }),
      ).pipe(
        Effect.mapError((cause) =>
          normalizeCodexError(operation, cause, "Failed to collect process output"),
        ),
      );
      return text;
    });

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> => {
    const filePath = path.join(tempDir, `t3code-${prefix}-${process.pid}-${randomUUID()}.tmp`);
    return fileSystem.writeFileString(filePath, content).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `Failed to write temp file at ${filePath}.`,
            cause,
          }),
      ),
      Effect.as(filePath),
    );
  };

  const writeTempBinaryFile = (
    operation: string,
    prefix: string,
    bytes: Uint8Array,
    extension: string,
  ): Effect.Effect<string, TextGenerationError> => {
    const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
    const filePath = path.join(
      tempDir,
      `t3code-${prefix}-${process.pid}-${randomUUID()}${normalizedExtension}`,
    );
    return fileSystem.writeFile(filePath, bytes).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `Failed to write temp file at ${filePath}.`,
            cause,
          }),
      ),
      Effect.as(filePath),
    );
  };

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

  const materializeImageAttachments = (
    operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName",
    attachments: BranchNameGenerationInput["attachments"],
  ): Effect.Effect<ReadonlyArray<string>, TextGenerationError> =>
    Effect.gen(function* () {
      if (!attachments || attachments.length === 0) {
        return [];
      }

      const imagePaths: string[] = [];
      for (const [index, attachment] of attachments.entries()) {
        if (attachment.type !== "image") {
          continue;
        }

        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (!parsed || !parsed.mimeType.startsWith("image/")) {
          continue;
        }

        const bytes = Buffer.from(parsed.base64, "base64");
        if (bytes.byteLength === 0) {
          continue;
        }

        const extension = inferImageExtension({
          mimeType: parsed.mimeType,
          fileName: attachment.name,
        });
        const imagePath = yield* writeTempBinaryFile(
          operation,
          `codex-image-${index}`,
          bytes,
          extension,
        );
        imagePaths.push(imagePath);
      }
      return imagePaths;
    });

  const runCodexJson = <T>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    parse,
  }: {
    operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
    cwd: string;
    prompt: string;
    outputSchemaJson: object;
    imagePaths?: ReadonlyArray<string>;
    parse: (raw: unknown) => T;
  }): Effect.Effect<T, TextGenerationError> =>
    Effect.gen(function* () {
      const schemaPath = yield* writeTempFile(
        operation,
        "codex-schema",
        JSON.stringify(outputSchemaJson),
      );
      const outputPath = yield* writeTempFile(operation, "codex-output", "");

      const runCodexCommand = Effect.gen(function* () {
        const command = ChildProcess.make(
          "codex",
          [
            "exec",
            "--ephemeral",
            "-s",
            "read-only",
            "--model",
            CODEX_MODEL,
            "--config",
            `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
            "-",
          ],
          {
            cwd,
            stdin: {
              stream: Stream.make(new TextEncoder().encode(prompt)),
            },
          },
        );

        const child = yield* commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCodexError(operation, cause, "Failed to spawn Codex CLI process"),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            readStreamAsString(operation, child.stdout),
            readStreamAsString(operation, child.stderr),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError((cause) =>
                normalizeCodexError(operation, cause, "Failed to read Codex CLI exit code"),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

        if (exitCode !== 0) {
          const stderrDetail = stderr.trim();
          const stdoutDetail = stdout.trim();
          const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
          return yield* new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Codex CLI command failed: ${detail}`
                : `Codex CLI command failed with code ${exitCode}.`,
          });
        }
      });

      const cleanup = Effect.all(
        [schemaPath, outputPath, ...imagePaths].map((filePath) => safeUnlink(filePath)),
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.asVoid);

      return yield* Effect.gen(function* () {
        yield* runCodexCommand.pipe(
          Effect.scoped,
          Effect.timeoutOption(CODEX_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
                ),
              onSome: () => Effect.void,
            }),
          ),
        );

        const rawOutput = yield* fileSystem.readFileString(outputPath).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to read Codex output file.",
                cause,
              }),
          ),
        );
        const trimmed = rawOutput.trim();
        if (trimmed.length === 0) {
          return yield* new TextGenerationError({
            operation,
            detail: "Codex returned an empty response.",
          });
        }

        const parsedJson = yield* Effect.try({
          try: () => JSON.parse(trimmed) as unknown,
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Codex returned invalid JSON output.",
              cause,
            }),
        });

        return yield* Effect.try({
          try: () => parse(parsedJson),
          catch: (cause) =>
            normalizeCodexError(operation, cause, "Codex returned invalid structured output"),
        });
      }).pipe(Effect.ensuring(cleanup));
    });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const prompt = [
      "You write concise git commit messages.",
      "Return a JSON object with keys: subject, body.",
      "Rules:",
      "- subject must be imperative, <= 72 chars, and no trailing period",
      "- body can be empty string or short bullet points",
      "- capture the primary user-visible or developer-visible change",
      "",
      `Branch: ${input.branch ?? "(detached)"}`,
      "",
      "Staged files:",
      limitSection(input.stagedSummary, 6_000),
      "",
      "Staged patch:",
      limitSection(input.stagedPatch, 40_000),
    ].join("\n");

    return runCodexJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: COMMIT_OUTPUT_SCHEMA_JSON,
      parse: (raw) => parseCommitOutput(raw),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
          }) satisfies CommitMessageGenerationResult,
      ),
    );
  };

  const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
    const prompt = [
      "You write GitHub pull request content.",
      "Return a JSON object with keys: title, body.",
      "Rules:",
      "- title should be concise and specific",
      "- body must be markdown and include headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      "",
      `Base branch: ${input.baseBranch}`,
      `Head branch: ${input.headBranch}`,
      "",
      "Commits:",
      limitSection(input.commitSummary, 12_000),
      "",
      "Diff stat:",
      limitSection(input.diffSummary, 12_000),
      "",
      "Diff patch:",
      limitSection(input.diffPatch, 40_000),
    ].join("\n");

    return runCodexJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: PR_OUTPUT_SCHEMA_JSON,
      parse: (raw) => parsePrOutput(raw),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            title: sanitizePrTitle(generated.title),
            body: generated.body.trim(),
          }) satisfies PrContentGenerationResult,
      ),
    );
  };

  const generateBranchName: TextGenerationShape["generateBranchName"] = (input) => {
    return Effect.gen(function* () {
      const imagePaths = yield* materializeImageAttachments("generateBranchName", input.attachments);
      const attachmentLines = (input.attachments ?? []).map(
        (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
      );

      const promptSections = [
        "You generate concise git branch names.",
        "Return a JSON object with key: branch.",
        "Rules:",
        "- Branch should describe the requested work from the user message.",
        "- Keep it short and specific (2-6 words).",
        "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
        "- If images are attached, use them as primary context for visual/UI issues.",
        "",
        "User message:",
        limitSection(input.message, 8_000),
      ];
      if (attachmentLines.length > 0) {
        promptSections.push(
          "",
          "Attachment metadata:",
          limitSection(attachmentLines.join("\n"), 4_000),
        );
      }
      const prompt = promptSections.join("\n");

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: BRANCH_NAME_OUTPUT_SCHEMA_JSON,
        imagePaths,
        parse: (raw) => parseBranchNameOutput(raw),
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("branch-name generation failed, skipping rename", {
              operation: "generateBranchName",
              reason: error instanceof Error ? error.message : String(error),
            });
            return { branch: null };
          }),
        ),
      );

      return {
        branch: generated.branch ? sanitizeBranchName(generated.branch) : null,
      } satisfies BranchNameGenerationResult;
    });
  };

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
  } satisfies TextGenerationShape;
});

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration);
