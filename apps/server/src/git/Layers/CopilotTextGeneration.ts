import {
  CopilotClient,
  type CopilotClientOptions,
  type PermissionRequestResult,
} from "@github/copilot-sdk";
import { DEFAULT_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { Effect, Layer, Schema, SchemaIssue } from "effect";

import {
  normalizeCopilotCliPathOverride,
  resolveBundledCopilotCliPath,
} from "../../provider/Layers/copilotCliPath.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CopilotTextGeneration,
  type CopilotTextGenerationShape,
} from "../Services/CopilotTextGeneration.ts";
import type {
  CommitMessageGenerationResult,
  PrContentGenerationResult,
} from "../Services/TextGeneration.ts";

const COPILOT_TIMEOUT_MS = 180_000;
const DENY_PERMISSION_RESULT: PermissionRequestResult = {
  kind: "denied-interactively-by-user",
};

const CommitMessageResponseSchema = Schema.Struct({
  subject: Schema.String,
  body: Schema.String,
  branch: Schema.optional(Schema.String),
});

const PrContentResponseSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
});

interface CopilotClientHandle {
  createSession(
    config: Parameters<CopilotClient["createSession"]>[0],
  ): Promise<CopilotSessionHandle>;
  stop(): Promise<ReadonlyArray<Error>>;
}

interface CopilotSessionHandle {
  destroy(): Promise<void>;
  sendAndWait(
    input: {
      prompt: string;
      mode: "immediate";
    },
    timeoutMs: number,
  ): Promise<{
    data?: {
      content?: string;
    };
  }>;
}

export interface CopilotTextGenerationLiveOptions {
  readonly cliPath?: string;
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotClientHandle;
}

function normalizeCopilotError(
  operation: "generateCommitMessage" | "generatePrContent",
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("enoent") || lower.includes("spawn")) {
      return new TextGenerationError({
        operation,
        detail: "GitHub Copilot CLI is required but was not found.",
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
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  return singleLine.length > 0 ? singleLine : "Update project changes";
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    return fenced.trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function decodeJsonResponse<S extends Schema.Top>(
  operation: "generateCommitMessage" | "generatePrContent",
  raw: string,
  schema: S,
): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> {
  return Effect.gen(function* () {
    const jsonText = extractJsonObject(raw);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(jsonText) as unknown,
      catch: (cause) =>
        normalizeCopilotError(operation, cause, "GitHub Copilot returned invalid JSON"),
    });

    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `GitHub Copilot returned an unexpected payload: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
            cause,
          }),
      ),
    );
  });
}

export const makeCopilotTextGenerationLive = (options?: CopilotTextGenerationLiveOptions) =>
  Layer.effect(
    CopilotTextGeneration,
    Effect.sync(() => {
      const runCopilotJson = <S extends Schema.Top>({
        operation,
        prompt,
        schema,
      }: {
        operation: "generateCommitMessage" | "generatePrContent";
        prompt: string;
        schema: S;
      }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
        Effect.gen(function* () {
          const cliPath =
            normalizeCopilotCliPathOverride(options?.cliPath) ?? resolveBundledCopilotCliPath();
          const model = DEFAULT_MODEL_BY_PROVIDER.copilot;
          const clientOptions: CopilotClientOptions = {
            ...(cliPath ? { cliPath } : {}),
            logLevel: "error",
          };
          const client = options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
          let session: CopilotSessionHandle | undefined;
          const cleanup = Effect.promise(async () => {
            if (session) {
              await session.destroy().catch(() => undefined);
            }
            await client.stop().catch(() => []);
          }).pipe(Effect.asVoid);

          return yield* Effect.gen(function* () {
            const createdSession = yield* Effect.tryPromise({
              try: () =>
                client.createSession({
                  model,
                  onPermissionRequest: () => DENY_PERMISSION_RESULT,
                  systemMessage: {
                    mode: "append",
                    content:
                      "Do not use tools, do not request permissions, and answer using only valid JSON with no markdown fences or prose.",
                  },
                }),
              catch: (cause) =>
                normalizeCopilotError(
                  operation,
                  cause,
                  "Failed to start a GitHub Copilot text-generation session",
                ),
            });
            session = createdSession;

            const response = yield* Effect.tryPromise({
              try: () => createdSession.sendAndWait({ prompt, mode: "immediate" }, COPILOT_TIMEOUT_MS),
              catch: (cause) =>
                normalizeCopilotError(
                  operation,
                  cause,
                  "GitHub Copilot did not finish generating text",
                ),
            });

            const responseContent =
              response &&
              typeof response === "object" &&
              "data" in response &&
              response.data &&
              typeof response.data === "object" &&
              "content" in response.data &&
              typeof response.data.content === "string"
                ? response.data.content
                : null;

            if (!responseContent) {
              return yield* new TextGenerationError({
                operation,
                detail: "GitHub Copilot did not return any text.",
              });
            }

            return yield* decodeJsonResponse(operation, responseContent, schema);
          }).pipe(Effect.ensuring(cleanup));
        });

      const generateCommitMessage: CopilotTextGenerationShape["generateCommitMessage"] = (input) => {
        const prompt = [
          "You write concise git commit messages.",
          input.includeBranch === true
            ? "Return a JSON object with keys: subject, body, branch."
            : "Return a JSON object with keys: subject, body.",
          "Rules:",
          "- subject must be imperative, <= 72 chars, and have no trailing period",
          "- body can be an empty string or short bullet points",
          ...(input.includeBranch === true
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

        return runCopilotJson({
          operation: "generateCommitMessage",
          prompt,
          schema: CommitMessageResponseSchema,
        }).pipe(
          Effect.map(
            (generated) =>
              ({
                subject: generated.subject,
                body: generated.body.trim(),
                ...(generated.branch ? { branch: sanitizeFeatureBranchName(generated.branch) } : {}),
              }) satisfies CommitMessageGenerationResult,
          ),
        );
      };

      const generatePrContent: CopilotTextGenerationShape["generatePrContent"] = (input) => {
        const prompt = [
          "You write GitHub pull request content.",
          "Return a JSON object with keys: title, body.",
          "Rules:",
          "- title should be concise and specific",
          "- body must be markdown and include headings '## Summary' and '## Testing'",
          "- under Summary, provide short bullet points",
          "- under Testing, mention concrete commands when available",
          "",
          `Base branch: ${input.baseBranch}`,
          `Head branch: ${input.headBranch}`,
          "",
          "Commit summary:",
          limitSection(input.commitSummary, 6_000),
          "",
          "Diff summary:",
          limitSection(input.diffSummary, 8_000),
          "",
          "Diff patch:",
          limitSection(input.diffPatch, 40_000),
        ].join("\n");

        return runCopilotJson({
          operation: "generatePrContent",
          prompt,
          schema: PrContentResponseSchema,
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

      return {
        generateCommitMessage,
        generatePrContent,
      } satisfies CopilotTextGenerationShape;
    }),
  );
