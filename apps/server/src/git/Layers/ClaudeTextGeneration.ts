import {
  query,
  type Options as ClaudeQueryOptions,
  type Query,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Layer, Option, Schema } from "effect";

import { DEFAULT_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { TextGenerationError } from "../Errors.ts";
import { ClaudeTextGenerationBackend } from "../Services/TextGenerationBackends.ts";
import {
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import { toTextGenerationOutputJsonSchema } from "./TextGenerationJsonSchema.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
const CLAUDE_BINARY_PATH = "claude";

export interface ClaudeTextGenerationLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: string;
    readonly options: ClaudeQueryOptions;
  }) => Query;
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

function resultFailureDetail(result: SDKResultMessage): string {
  if (result.subtype === "success") {
    return "";
  }
  const joinedErrors = Array.isArray(result.errors) ? result.errors.join(" ").trim() : "";
  return joinedErrors.length > 0
    ? joinedErrors
    : `Claude request failed with status ${result.subtype}.`;
}

function parseClaudeStructuredOutput(result: SDKResultMessage): unknown {
  if (result.subtype !== "success") {
    return undefined;
  }
  if (result.structured_output !== undefined) {
    return result.structured_output;
  }
  try {
    return JSON.parse(result.result);
  } catch {
    return result.result;
  }
}

function createClaudeTextGenerationService(
  options?: ClaudeTextGenerationLiveOptions,
): TextGenerationShape {
  const createQuery =
    options?.createQuery ??
    ((input: { readonly prompt: string; readonly options: ClaudeQueryOptions }) =>
      query({ prompt: input.prompt, options: input.options }));

  const runClaudeJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    model,
  }: {
    operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    model?: string;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const resolvedModel =
        normalizeModelSlug(model, "claudeAgent") ?? DEFAULT_MODEL_BY_PROVIDER.claudeAgent;
      const queryOptions: ClaudeQueryOptions = {
        cwd,
        additionalDirectories: [cwd],
        model: resolvedModel,
        outputFormat: {
          type: "json_schema",
          schema: toTextGenerationOutputJsonSchema(outputSchemaJson),
        },
        pathToClaudeCodeExecutable: CLAUDE_BINARY_PATH,
        permissionMode: "plan",
        tools: [],
        persistSession: false,
        includePartialMessages: false,
        env: process.env,
      };

      const result = yield* Effect.tryPromise({
        try: async () => {
          const queryRuntime = createQuery({
            prompt,
            options: queryOptions,
          });

          let finalResult: SDKResultMessage | null = null;
          try {
            for await (const message of queryRuntime) {
              if (message.type !== "result") {
                continue;
              }
              finalResult = message;
            }
          } finally {
            queryRuntime.close();
          }

          if (!finalResult) {
            throw new Error("Claude did not return a final result.");
          }

          return finalResult;
        },
        catch: (cause) =>
          normalizeClaudeError(operation, cause, "Failed to run Claude CLI structured request"),
      }).pipe(
        Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Claude CLI request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      if (result.subtype !== "success") {
        return yield* new TextGenerationError({
          operation,
          detail: `Claude CLI request failed: ${resultFailureDetail(result)}`,
        });
      }

      const rawOutput = parseClaudeStructuredOutput(result);

      return yield* Schema.decodeUnknownEffect(outputSchemaJson)(rawOutput).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
        ),
      );
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
      ...(input.model ? { model: input.model } : {}),
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
      ...(input.model ? { model: input.model } : {}),
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
    const prompt = [
      "You generate concise git branch names.",
      "Return a JSON object with key: branch.",
      "Rules:",
      "- branch must be a lowercase semantic git branch fragment",
      "- use slash-separated segments only when it improves clarity",
      "- avoid prefixes like feat/ or fix/ unless the change clearly needs one",
      "- use plain words only, no issue prefixes and no punctuation-heavy text",
      "",
      "User message:",
      limitSection(input.message, 8_000),
    ].join("\n");

    return runClaudeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: Schema.Struct({
        branch: Schema.String,
      }),
      ...(input.model ? { model: input.model } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            branch: sanitizeBranchFragment(generated.branch),
          }) satisfies BranchNameGenerationResult,
      ),
    );
  };

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
  } satisfies TextGenerationShape;
}

export const makeClaudeTextGeneration = (options?: ClaudeTextGenerationLiveOptions) =>
  Effect.succeed(createClaudeTextGenerationService(options));

export const ClaudeTextGenerationLive = Layer.effect(TextGeneration, makeClaudeTextGeneration());
export const ClaudeTextGenerationBackendLive = Layer.effect(
  ClaudeTextGenerationBackend,
  makeClaudeTextGeneration(),
);
