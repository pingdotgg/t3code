import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type JiraTicketContentGenerationResult,
  type JiraProgressCommentGenerationResult,
  type JiraCompletionSummaryGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const CLAUDE_MODEL = "haiku";
const CLAUDE_TIMEOUT_MS = 180_000;

function toJsonSchema(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema;
}

function normalizeClaudeError(
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
      error.message.includes("Command not found: claude") ||
      lower.includes("spawn claude") ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: "Claude CLI (`claude`) is required but not available on PATH.",
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

const makeCodexTextGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

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
          normalizeClaudeError(operation, cause, "Failed to collect process output"),
        ),
      );
      return text;
    });

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

  const materializeImageAttachments = (
    _operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName",
    attachments: BranchNameGenerationInput["attachments"],
  ): Effect.Effect<MaterializedImageAttachments, TextGenerationError> =>
    Effect.gen(function* () {
      if (!attachments || attachments.length === 0) {
        return { imagePaths: [] };
      }

      const imagePaths: string[] = [];
      for (const attachment of attachments) {
        if (attachment.type !== "image") {
          continue;
        }

        const resolvedPath = resolveAttachmentPath({
          stateDir: serverConfig.stateDir,
          attachment,
        });
        if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
          continue;
        }
        const fileInfo = yield* fileSystem
          .stat(resolvedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          continue;
        }
        imagePaths.push(resolvedPath);
      }
      return { imagePaths };
    });

  const runClaudeJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    cleanupPaths = [],
  }: {
    operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const jsonSchema = JSON.stringify(toJsonSchema(outputSchemaJson));

      const runClaudeCommand = Effect.gen(function* () {
        const command = ChildProcess.make(
          "claude",
          [
            "--print",
            "--model",
            CLAUDE_MODEL,
            "--output-format",
            "json",
            "--json-schema",
            jsonSchema,
            "--no-session-persistence",
            "--dangerously-skip-permissions",
            prompt,
          ],
          {
            cwd,
            shell: process.platform === "win32",
          },
        );

        const child = yield* commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeClaudeError(operation, cause, "Failed to spawn Claude CLI process"),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            readStreamAsString(operation, child.stdout),
            readStreamAsString(operation, child.stderr),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError((cause) =>
                normalizeClaudeError(operation, cause, "Failed to read Claude CLI exit code"),
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
                ? `Claude CLI command failed: ${detail}`
                : `Claude CLI command failed with code ${exitCode}.`,
          });
        }

        return stdout;
      });

      const cleanup = Effect.all(
        cleanupPaths.map((filePath) => safeUnlink(filePath)),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid);

      return yield* Effect.gen(function* () {
        const stdout = yield* runClaudeCommand.pipe(
          Effect.scoped,
          Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
        );

        return yield* Effect.succeed(stdout).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))),
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Claude returned invalid structured output.",
                cause,
              }),
            ),
          ),
        );
      }).pipe(Effect.ensuring(cleanup));
    });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;

    const prompt = [
      "You write concise git commit messages.",
      wantsBranch
        ? "Return a JSON object with keys: subject, body, branch."
        : "Return a JSON object with keys: subject, body.",
      "Rules:",
      "- subject must be imperative, <= 72 chars, and no trailing period",
      "- body can be empty string or short bullet points",
      ...(wantsBranch
        ? ["- branch must be a short semantic git branch fragment for this change"]
        : []),
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

    const outputSchemaJson = wantsBranch
      ? Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
          branch: Schema.String,
        })
      : Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
        });

    return runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
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

    return runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: Schema.Struct({
        title: Schema.String,
        body: Schema.String,
      }),
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
      const { imagePaths } = yield* materializeImageAttachments(
        "generateBranchName",
        input.attachments,
      );
      const attachmentLines = (input.attachments ?? []).map(
        (attachment) =>
          `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
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

      const generated = yield* runClaudeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: Schema.Struct({
          branch: Schema.String,
        }),
        imagePaths,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      } satisfies BranchNameGenerationResult;
    });
  };

  const generateJiraTicketContent: TextGenerationShape["generateJiraTicketContent"] = (input) => {
    const prompt = [
      "You create Jira ticket content from conversation context.",
      "Return a JSON object with keys: summary, description.",
      "Rules:",
      "- summary: concise ticket title (imperative, 5-15 words)",
      "- description: markdown body with context, acceptance criteria, and scope",
      "",
      `Project key: ${input.projectKey}`,
      "",
      "Conversation context:",
      limitSection(input.conversationContext, 16_000),
    ].join("\n");

    return runClaudeJson({
      operation: "generateCommitMessage",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: Schema.Struct({
        summary: Schema.String,
        description: Schema.String,
      }),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            summary: generated.summary.trim(),
            description: generated.description.trim(),
          }) satisfies JiraTicketContentGenerationResult,
      ),
    );
  };

  const generateJiraProgressComment: TextGenerationShape["generateJiraProgressComment"] = (
    input,
  ) => {
    const prompt = [
      "You write concise Jira progress comments.",
      "Return a JSON object with key: comment.",
      "Rules:",
      "- Summarize what was accomplished in the conversation",
      "- Use bullet points for key changes",
      "- Keep it factual and brief (3-8 bullet points)",
      "",
      `Ticket: ${input.ticketKey} - ${input.ticketTitle}`,
      "",
      "Recent conversation:",
      limitSection(input.recentConversation, 16_000),
    ].join("\n");

    return runClaudeJson({
      operation: "generateCommitMessage",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: Schema.Struct({
        comment: Schema.String,
      }),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            comment: generated.comment.trim(),
          }) satisfies JiraProgressCommentGenerationResult,
      ),
    );
  };

  const generateJiraCompletionSummary: TextGenerationShape["generateJiraCompletionSummary"] = (
    input,
  ) => {
    const prompt = [
      "You write Jira completion summaries for finished work.",
      "Return a JSON object with key: comment.",
      "Rules:",
      "- Summarize the full scope of work completed",
      "- Include key changes, files modified, and testing notes",
      "- Use bullet points, keep it factual (5-12 bullet points)",
      "",
      `Ticket: ${input.ticketKey} - ${input.ticketTitle}`,
      "",
      "Full conversation:",
      limitSection(input.fullConversation, 24_000),
    ].join("\n");

    return runClaudeJson({
      operation: "generateCommitMessage",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: Schema.Struct({
        comment: Schema.String,
      }),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            comment: generated.comment.trim(),
          }) satisfies JiraCompletionSummaryGenerationResult,
      ),
    );
  };

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateJiraTicketContent,
    generateJiraProgressComment,
    generateJiraCompletionSummary,
  } satisfies TextGenerationShape;
});

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration);
