import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type OpenCodeSettings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../provider/OpenCodeServerOwner.ts";

const OpenCodeTextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
]);

type OpenCodeTextGenerationOperation = typeof OpenCodeTextGenerationOperation.Type;

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedError<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedError<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedError<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedError<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedError<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name = "type" in error && typeof error.type === "string" ? error.type : undefined;
  const message =
    "message" in error && typeof error.message === "string" ? error.message.trim() : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation: OpenCodeTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
      function* (
        server: Pick<
          OpenCodeRuntime.OpenCodeServerConnection,
          "url" | "serverPassword" | "version"
        >,
      ) {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        });
        const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
        const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const session = yield* Effect.tryPromise({
          try: () =>
            client.session.create({
              title: `T3 Code ${input.operation}`,
              location: { directory: input.cwd },
              permissions: [{ action: "*", resource: "*", effect: "deny" }],
              model: {
                providerID: parsedModel.providerID,
                id: parsedModel.modelID,
                ...(selectedVariant ? { variant: selectedVariant } : {}),
              },
              ...(selectedAgent ? { agent: selectedAgent } : {}),
            }),
          catch: (cause) =>
            new OpenCodeTextGenerationSessionRequestError({
              operation: input.operation,
              cwd: input.cwd,
              cause,
            }),
        });
        if (!session?.id) {
          return yield* new OpenCodeTextGenerationSessionPayloadError({
            operation: input.operation,
            cwd: input.cwd,
          });
        }
        const promptContext = {
          operation: input.operation,
          cwd: input.cwd,
          sessionId: session.id,
          providerId: parsedModel.providerID,
          modelId: parsedModel.modelID,
        };

        const result = yield* Effect.tryPromise({
          try: async () => {
            await client.session.prompt({
              sessionID: session.id,
              text: input.prompt,
              files: fileParts,
            });
            // `session.wait` never resolves on its own when OpenCode stalls;
            // bound it to the same 10-minute budget the v2 adapter uses for
            // compaction so a hung request surfaces as a TextGenerationError
            // through the prompt-request error path below. Aborting only ends
            // the HTTP wait — interrupt the session so OpenCode does not keep
            // generating (and billing) after we have given up on it.
            const waitSignal = AbortSignal.timeout(10 * 60_000);
            try {
              await client.session.wait({ sessionID: session.id }, { signal: waitSignal });
            } catch (cause) {
              if (waitSignal.aborted) {
                try {
                  // Bound the cleanup too: a hung interrupt must not hold the
                  // timed-out request open. The original wait error below is
                  // what the caller must see either way.
                  await client.session.interrupt(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(30_000) },
                  );
                } catch {
                  // Best effort: the session may already be gone. The original
                  // timeout error below is what the caller must see.
                }
              }
              throw cause;
            }
            const messages = await client.message.list(
              {
                sessionID: session.id,
                order: "desc",
              },
              // Same overall budget as the wait above: a hung history fetch
              // must not leave the generation pending indefinitely.
              { signal: waitSignal },
            );
            return messages.data.find((message) => message.type === "assistant");
          },
          catch: (cause) =>
            new OpenCodeTextGenerationPromptRequestError({
              ...promptContext,
              cause,
            }),
        });
        const promptFailure = getOpenCodePromptFailure(result?.error);
        if (promptFailure) {
          return yield* new OpenCodeTextGenerationPromptResponseError({
            ...promptContext,
            ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
            providerMessage: promptFailure.message,
          });
        }
        const responseParts = result?.content ?? [];
        const rawText = getOpenCodeTextResponse(responseParts);
        if (rawText.length === 0) {
          return yield* new OpenCodeTextGenerationEmptyOutputError({
            ...promptContext,
            responsePartCount: responseParts.length,
            textPartCount: responseParts.filter(isOpenCodeTextPart).length,
          });
        }
        return rawText;
      },
      Effect.catchTags({
        OpenCodeTextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.prompt request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCodeTextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode returned empty output.",
              cause,
            }),
          ),
      }),
    );

    const serverOutput =
      openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory: input.cwd,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
        : serverOwner.withServer(runAgainstServer);
    const rawOutput = yield* serverOutput.pipe(
      Effect.catchTags({
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
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
              detail: "OpenCode returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OpenCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOpenCodeJson({
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
    Effect.fn("OpenCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runOpenCodeJson({
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
    Effect.fn("OpenCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OpenCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
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
});
