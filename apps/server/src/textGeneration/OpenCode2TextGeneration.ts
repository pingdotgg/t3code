import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import {
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
} from "../provider/opencodeRuntime.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../textGeneration/TextGenerationPrompts.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../textGeneration/TextGenerationUtils.ts";

/**
 * Text generation over an OpenCode 2 server.
 *
 * Each operation runs inside an ephemeral V2 session created with deny-all
 * permissions, prompts for JSON output, waits for the turn to settle, then
 * reads the assistant messages back and extracts the JSON payload.
 *
 * The connection is injected: callers pass `withConnection`, which supplies
 * a V2 client for the duration of one operation and may fail with
 * `OpenCodeRuntimeError` when the server borrow itself fails (mapped to
 * `TextGenerationError` alongside the per-request failures below).
 */

// ---------------------------------------------------------------------------
// Minimal structural V2 client surface (covers exactly what generation uses)
// ---------------------------------------------------------------------------

interface OpenCode2SessionHandle {
  readonly id: string;
}

interface OpenCode2TextEntry {
  readonly type: "text";
  readonly text: string;
}

interface OpenCode2AssistantMessage {
  readonly id: string;
  readonly type: "assistant";
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly error?: { readonly message?: string };
}

export interface OpenCode2TextGenerationClient {
  readonly session: {
    readonly create: (input: {
      readonly title?: string;
      readonly directory?: string;
      readonly permissions: ReadonlyArray<{
        readonly action: string;
        readonly resource: string;
        readonly effect: "allow" | "deny" | "ask";
      }>;
    }) => Promise<{ readonly id: string }>;
    readonly switchModel: (input: {
      readonly sessionID: string;
      readonly model: {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string;
      };
    }) => Promise<unknown>;
    readonly switchAgent: (input: {
      readonly sessionID: string;
      readonly agent: string;
    }) => Promise<unknown>;
    readonly prompt: (input: {
      readonly sessionID: string;
      readonly text: string;
    }) => Promise<unknown>;
    readonly wait: (input: { readonly sessionID: string }) => Promise<unknown>;
    readonly context: (input: { readonly sessionID: string }) => Promise<
      ReadonlyArray<{
        readonly id: string;
        readonly type: string;
        readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
        readonly error?: { readonly message?: string };
      }>
    >;
  };
}

/** Supplies a V2 client for one generation operation. */
export type OpenCode2ConnectionProvider = <A, E, R>(
  use: (client: OpenCode2TextGenerationClient) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | OpenCodeRuntimeError, R>;

/** Bounds one ephemeral generation turn (create → prompt → wait → context). */
const OPENCODE2_TEXT_GENERATION_TIMEOUT_MS = 180_000;

const OpenCode2TextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
]);

type OpenCode2TextGenerationOperation = typeof OpenCode2TextGenerationOperation.Type;

const operationContext = {
  operation: OpenCode2TextGenerationOperation,
};

export class OpenCode2TextGenerationSessionRequestError extends Schema.TaggedError<OpenCode2TextGenerationSessionRequestError>()(
  "OpenCode2TextGenerationSessionRequestError",
  {
    ...operationContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode 2 session creation request failed for ${this.operation}.`;
  }
}

export class OpenCode2TextGenerationSessionPayloadError extends Schema.TaggedError<OpenCode2TextGenerationSessionPayloadError>()(
  "OpenCode2TextGenerationSessionPayloadError",
  {
    ...operationContext,
  },
) {
  override get message(): string {
    return `OpenCode 2 session.create returned no session payload for ${this.operation}.`;
  }
}

export class OpenCode2TextGenerationPromptRequestError extends Schema.TaggedError<OpenCode2TextGenerationPromptRequestError>()(
  "OpenCode2TextGenerationPromptRequestError",
  {
    ...operationContext,
    sessionId: Schema.String,
    providerId: Schema.String,
    modelId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode 2 prompt request failed for ${this.operation} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCode2TextGenerationPromptResponseError extends Schema.TaggedError<OpenCode2TextGenerationPromptResponseError>()(
  "OpenCode2TextGenerationPromptResponseError",
  {
    ...operationContext,
    sessionId: Schema.String,
    providerId: Schema.String,
    modelId: Schema.String,
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    return `OpenCode 2 prompt failed for ${this.operation} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCode2TextGenerationEmptyOutputError extends Schema.TaggedError<OpenCode2TextGenerationEmptyOutputError>()(
  "OpenCode2TextGenerationEmptyOutputError",
  {
    ...operationContext,
    sessionId: Schema.String,
    providerId: Schema.String,
    modelId: Schema.String,
    messageCount: Schema.Number,
    textPartCount: Schema.Number,
  },
) {
  override get message(): string {
    return `OpenCode 2 returned empty output for ${this.operation} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.messageCount} assistant messages, ${this.textPartCount} text entries).`;
  }
}

function isTextEntry(entry: {
  readonly type: string;
  readonly text?: string;
}): entry is OpenCode2TextEntry {
  return entry.type === "text" && typeof entry.text === "string";
}

function asMessageRecord(message: unknown): OpenCode2ContextMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  // Only `type` gates the join; `id`/`error` are validated where used so a
  // missing id never drops an otherwise well-formed assistant message.
  if (typeof record["type"] !== "string") return undefined;
  const content = record["content"];
  if (content !== undefined && !Array.isArray(content)) return undefined;
  const error = record["error"];
  if (error !== undefined && (typeof error !== "object" || error === null)) return undefined;
  return message as OpenCode2ContextMessage;
}

function assistantErrorOf(message: OpenCode2ContextMessage): string | undefined {
  const candidate = (message.error as { readonly message?: unknown } | undefined)?.message;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

interface OpenCode2ContextMessage {
  readonly id: string;
  readonly type: string;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly error?: { readonly message?: string };
}

/** Joins assistant-message text entries in order (mirrors the v2 compat `toParts`). */
export function joinAssistantText(messages: ReadonlyArray<unknown>): {
  readonly rawText: string;
  readonly messageCount: number;
  readonly textPartCount: number;
} {
  const texts: Array<string> = [];
  let messageCount = 0;
  let textPartCount = 0;
  for (const message of messages) {
    // `session.context` is server data: skip malformed entries instead of
    // throwing (a null entry or a non-array `content` must not kill the turn).
    const record = asMessageRecord(message);
    if (record === undefined || record.type !== "assistant") {
      continue;
    }
    messageCount += 1;
    for (const entry of record.content ?? []) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        isTextEntry(entry as { readonly type: string; readonly text?: string })
      ) {
        textPartCount += 1;
        texts.push((entry as OpenCode2TextEntry).text);
      }
    }
  }
  return { rawText: texts.join("").trim(), messageCount, textPartCount };
}
/**
 * Builds the TextGeneration service over an OpenCode 2 server. The connection
 * is injected via `withConnection` (see module docs) so this module stays
 * decoupled from the server lifecycle: the driver supplies
 * `server.withConnection` (see `OpenCode2Driver`). A plain function
 * (not an Effect constructor): nothing here needs services or scope — every
 * operation threads effects through `withConnection` itself.
 */
export const makeOpenCode2TextGeneration = (
  withConnection: OpenCode2ConnectionProvider,
): TextGeneration.TextGeneration["Service"] => {
  const runJson = Effect.fn("runJson")(function* <S extends Schema.Top>(input: {
    readonly operation: OpenCode2TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }) {
    const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode 2 model selection must use the 'provider/model' format.",
      });
    }

    const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
    const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
    const promptContext = {
      operation: input.operation,
      providerId: parsedModel.providerID,
      modelId: parsedModel.modelID,
    };

    type RunWithClientError =
      | OpenCode2TextGenerationSessionRequestError
      | OpenCode2TextGenerationSessionPayloadError
      | OpenCode2TextGenerationPromptRequestError
      | OpenCode2TextGenerationPromptResponseError
      | OpenCode2TextGenerationEmptyOutputError;

    const runWithClient = (
      client: OpenCode2TextGenerationClient,
    ): Effect.Effect<string, RunWithClientError> =>
      Effect.gen(function* () {
        const created: unknown = yield* Effect.tryPromise({
          try: () =>
            client.session.create({
              title: `T3 Code ${input.operation}`,
              directory: input.cwd,
              permissions: [{ action: "*", resource: "*", effect: "deny" }],
            }),
          catch: (cause) =>
            new OpenCode2TextGenerationSessionRequestError({
              operation: input.operation,
              cause,
            }),
        });
        // The session id is server data: an empty or non-string id would
        // throw at the `sessionId: Schema.String` error constructors below,
        // so reject it here as a typed payload failure (mirrors v1's
        // `SessionPayloadError`).
        const createdRecord =
          typeof created === "object" && created !== null
            ? (created as Record<string, unknown>)
            : undefined;
        const sessionId =
          typeof createdRecord?.["id"] === "string" && createdRecord["id"].trim().length > 0
            ? (createdRecord["id"] as string)
            : undefined;
        if (sessionId === undefined) {
          return yield* new OpenCode2TextGenerationSessionPayloadError({
            operation: input.operation,
          });
        }
        const session: OpenCode2SessionHandle = { id: sessionId };
        const sessionContext = { ...promptContext, sessionId: session.id };

        if (selectedVariant !== undefined || selectedAgent !== undefined) {
          yield* Effect.tryPromise({
            try: async () => {
              await client.session.switchModel({
                sessionID: session.id,
                model: {
                  id: parsedModel.modelID,
                  providerID: parsedModel.providerID,
                  ...(selectedVariant !== undefined ? { variant: selectedVariant } : {}),
                },
              });
              if (selectedAgent !== undefined) {
                await client.session.switchAgent({ sessionID: session.id, agent: selectedAgent });
              }
            },
            catch: (cause) =>
              new OpenCode2TextGenerationPromptRequestError({ ...sessionContext, cause }),
          });
        }

        yield* Effect.tryPromise({
          try: () => client.session.prompt({ sessionID: session.id, text: input.prompt }),
          catch: (cause) =>
            new OpenCode2TextGenerationPromptRequestError({ ...sessionContext, cause }),
        });
        yield* Effect.tryPromise({
          try: () => client.session.wait({ sessionID: session.id }),
          catch: (cause) =>
            new OpenCode2TextGenerationPromptRequestError({ ...sessionContext, cause }),
        });
        const contextResult: unknown = yield* Effect.tryPromise({
          try: () => client.session.context({ sessionID: session.id }),
          catch: (cause) =>
            new OpenCode2TextGenerationPromptRequestError({ ...sessionContext, cause }),
        });
        // `session.context` is server data: require an array before touching
        // it, so a malformed payload maps to empty output instead of throwing.
        const messages: ReadonlyArray<unknown> = Array.isArray(contextResult) ? contextResult : [];

        const assistants = messages
          .map(asMessageRecord)
          .filter((message): message is OpenCode2AssistantMessage => message?.type === "assistant");
        const failed = assistants.find((message) => assistantErrorOf(message) !== undefined);
        const failedMessage = failed !== undefined ? assistantErrorOf(failed) : undefined;
        if (failedMessage !== undefined) {
          return yield* new OpenCode2TextGenerationPromptResponseError({
            ...sessionContext,
            providerMessage: failedMessage,
          });
        }

        const { rawText, messageCount, textPartCount } = joinAssistantText(messages);
        if (rawText.length === 0) {
          return yield* new OpenCode2TextGenerationEmptyOutputError({
            ...sessionContext,
            messageCount,
            textPartCount,
          });
        }
        return rawText;
      });

    const rawOutput = yield* withConnection(runWithClient).pipe(
      // `session.wait` never resolves against a hung server: bound the whole
      // operation like the other drivers (Codex/Claude use 180s) so a stale
      // server surfaces a typed failure instead of holding the borrow forever.
      Effect.timeoutOption(OPENCODE2_TEXT_GENERATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "OpenCode 2 text generation timed out.",
              }),
            ),
          onSome: (output) => Effect.succeed(output),
        }),
      ),
      Effect.catchTags({
        OpenCode2TextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode 2 session.create request failed.",
              cause,
            }),
          ),
        OpenCode2TextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode 2 session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCode2TextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode 2 session.prompt request failed.",
              cause,
            }),
          ),
        OpenCode2TextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCode2TextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode 2 returned empty output.",
              cause,
            }),
          ),
        // Borrow failures (spawn/verify/connect) surface here as
        // `OpenCodeRuntimeError`; map them to `TextGenerationError`,
        // mirroring v1 `makeOpenCodeTextGeneration`.
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: openCodeRuntimeErrorDetail(cause),
              cause,
            }),
          ),
      }),
    );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode 2 returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OpenCode2TextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OpenCode2TextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OpenCode2TextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OpenCode2TextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
};
