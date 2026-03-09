import { randomUUID } from "node:crypto";

import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option, Queue, Schema, SchemaIssue, Stream } from "effect";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
} from "../Services/TextGeneration.ts";
import {
  SessionTextGeneration,
  type SessionTextGenerationShape,
} from "../Services/SessionTextGeneration.ts";

const PROVIDER_TEXT_GENERATION_TIMEOUT_MS = 180_000;

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

function toThreadId(value: string): ThreadId {
  return value as ThreadId;
}

function normalizeProviderTextGenerationError(
  operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName",
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
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

function decodeJsonResponse<S extends Schema.Top>(
  operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName",
  raw: string,
  schema: S,
): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> {
  return Effect.gen(function* () {
    const jsonText = extractJsonObject(raw);
    if (jsonText.length === 0) {
      return yield* new TextGenerationError({
        operation,
        detail: "Provider returned an empty response.",
      });
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(jsonText) as unknown,
      catch: (cause) =>
        normalizeProviderTextGenerationError(
          operation,
          cause,
          "Provider returned invalid JSON",
        ),
    });

    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `Provider returned an unexpected payload: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
            cause,
          }),
      ),
    );
  });
}

function assistantMessageFromEvent(event: ProviderRuntimeEvent): string | null {
  if (
    event.type !== "item.completed" ||
    event.payload.itemType !== "assistant_message" ||
    typeof event.payload.detail !== "string"
  ) {
    return null;
  }
  const trimmed = event.payload.detail.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const makeSessionTextGeneration = Effect.gen(function* () {
  const providerService = yield* ProviderService;

  const runProviderJson = <S extends Schema.Top>({
    operation,
    cwd,
    provider,
    model,
    prompt,
    attachments,
    schema,
  }: {
    operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
    cwd: string;
    provider: BranchNameGenerationInput["provider"];
    model: BranchNameGenerationInput["model"];
    prompt: string;
    attachments?: BranchNameGenerationInput["attachments"];
    schema: S;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const resolvedProvider = provider ?? "codex";
      const resolvedModel = resolveModelSlugForProvider(resolvedProvider, model);
      const threadId = toThreadId(`git-textgen-${operation}-${randomUUID()}`);
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

      yield* Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.threadId !== threadId) {
          return Effect.void;
        }
        return Queue.offer(eventQueue, event).pipe(Effect.asVoid);
      }).pipe(Effect.forkScoped);

      const cleanup = providerService
        .stopSession({ threadId })
        .pipe(
          Effect.tapError((e) =>
            Effect.logWarning("Failed to stop text generation session", e),
          ),
          Effect.orElseSucceed(() => undefined),
          Effect.asVoid,
        );

      return yield* Effect.gen(function* () {
        yield* providerService.startSession(threadId, {
          threadId,
          provider: resolvedProvider,
          cwd,
          model: resolvedModel,
          runtimeMode: "approval-required",
        });

        const turn = yield* providerService.sendTurn({
          threadId,
          input: prompt,
          model: resolvedModel,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          interactionMode: "default",
        });

        let assistantText = "";
        let fallbackAssistantMessage: string | null = null;

        while (true) {
          const event = yield* Queue.take(eventQueue);
          if (event.turnId !== undefined && event.turnId !== turn.turnId) {
            continue;
          }

          if (
            event.type === "content.delta" &&
            event.payload.streamKind === "assistant_text"
          ) {
            assistantText += event.payload.delta;
            continue;
          }

          const assistantMessage = assistantMessageFromEvent(event);
          if (assistantMessage && fallbackAssistantMessage === null) {
            fallbackAssistantMessage = assistantMessage;
            continue;
          }

          if (event.type === "request.opened") {
            return yield* new TextGenerationError({
              operation,
              detail: `The ${resolvedProvider} provider requested '${event.payload.requestType}' while generating git text. Git text generation must run without tools or approvals.`,
            });
          }

          if (event.type === "user-input.requested") {
            return yield* new TextGenerationError({
              operation,
              detail: `The ${resolvedProvider} provider requested interactive input while generating git text.`,
            });
          }

          if (event.type === "runtime.error") {
            return yield* new TextGenerationError({
              operation,
              detail: `${resolvedProvider} provider runtime error: ${event.payload.message}`,
            });
          }

          if (event.type === "session.exited") {
            return yield* new TextGenerationError({
              operation,
              detail: `${resolvedProvider} provider session exited unexpectedly during text generation.`,
            });
          }

          if (event.type === "turn.completed") {
            if (event.payload.state !== "completed") {
              return yield* new TextGenerationError({
                operation,
                detail:
                  event.payload.errorMessage ??
                  `${resolvedProvider} provider turn ended with state '${event.payload.state}'.`,
              });
            }

            const responseText = assistantText.trim() || fallbackAssistantMessage?.trim() || "";
            return yield* decodeJsonResponse(operation, responseText, schema);
          }
        }
      }).pipe(
        Effect.timeoutOption(PROVIDER_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `${resolvedProvider} provider request timed out.`,
                }),
              ),
            onSome: (result) => Effect.succeed(result),
          }),
        ),
        Effect.ensuring(cleanup),
        Effect.scoped,
      );
    }).pipe(
      Effect.mapError((cause) =>
        normalizeProviderTextGenerationError(
          operation,
          cause,
          "Provider git text generation failed",
        ),
      ),
    );

  const generateCommitMessage: SessionTextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;
    const prompt = [
      "You write concise git commit messages.",
      "Answer using only valid JSON. Do not use tools, do not ask for approvals, and do not add markdown fences or prose.",
      wantsBranch
        ? 'Return a JSON object with keys: "subject", "body", "branch".'
        : 'Return a JSON object with keys: "subject", "body".',
      "Rules:",
      "- subject must be imperative, <= 72 chars, and have no trailing period",
      "- body can be an empty string or short bullet points",
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

    const schema = wantsBranch
      ? Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
          branch: Schema.String,
        })
      : Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
        });

    return runProviderJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      prompt,
      schema,
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            subject: generated.subject,
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          }) satisfies CommitMessageGenerationResult,
      ),
    );
  };

  const generatePrContent: SessionTextGenerationShape["generatePrContent"] = (input) => {
    const prompt = [
      "You write GitHub pull request content.",
      "Answer using only valid JSON. Do not use tools, do not ask for approvals, and do not add markdown fences or prose.",
      'Return a JSON object with keys: "title", "body".',
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

    return runProviderJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      prompt,
      schema: Schema.Struct({
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

  const generateBranchName: SessionTextGenerationShape["generateBranchName"] = (input) => {
    const attachmentLines = (input.attachments ?? []).map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    );
    const promptSections = [
      "You generate concise git branch names.",
      "Answer using only valid JSON. Do not use tools, do not ask for approvals, and do not add markdown fences or prose.",
      'Return a JSON object with key: "branch".',
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

    return runProviderJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      prompt: promptSections.join("\n"),
      attachments: input.attachments,
      schema: Schema.Struct({
        branch: Schema.String,
      }),
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
  } satisfies SessionTextGenerationShape;
});

export const SessionTextGenerationLive = Layer.effect(
  SessionTextGeneration,
  makeSessionTextGeneration,
);
