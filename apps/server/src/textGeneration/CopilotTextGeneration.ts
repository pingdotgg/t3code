import type { CopilotClient, CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { Effect, Exit, Fiber, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  type ChatAttachment,
  type CopilotSettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { createCopilotClient, trimOrUndefined } from "../provider/copilotRuntime.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const COPILOT_TIMEOUT_MS = 180_000;
const COPILOT_TEXT_GENERATION_IDLE_TTL = "30 seconds";

type CopilotTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";
type CopilotReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

interface SharedCopilotTextClientState {
  readonly client: CopilotClient;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

interface SharedCopilotTextClientLease {
  readonly clientKey: string;
  readonly client: CopilotClient;
}

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

function copilotJsonPrompt(prompt: string, outputSchemaJson: Schema.Top): string {
  const schemaDocument = JSON.stringify(toJsonSchemaObject(outputSchemaJson), null, 2);
  return `${prompt}

Return exactly one JSON object matching this schema:
${schemaDocument}

Do not wrap the JSON in markdown fences or include any other text.`;
}

function copilotTextGenerationError(
  operation: CopilotTextGenerationOperation,
  detail: string,
  cause?: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function detailFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function copilotTextClientKey(input: {
  readonly settings: CopilotSettings;
  readonly cwd: string;
}): string {
  return JSON.stringify({
    cwd: input.cwd,
    binaryPath: trimOrUndefined(input.settings.binaryPath) ?? null,
    serverUrl: trimOrUndefined(input.settings.serverUrl) ?? null,
  });
}

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: {
    readonly baseDirectory?: string;
  },
) {
  const serverConfig = yield* ServerConfig;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const sharedClientMutex = yield* Semaphore.make(1);
  const sharedClients = new Map<string, SharedCopilotTextClientState>();

  const closeSharedClient = (clientKey: string) =>
    Effect.gen(function* () {
      const state = sharedClients.get(clientKey);
      if (!state) {
        return;
      }

      sharedClients.delete(clientKey);
      const idleCloseFiber = state.idleCloseFiber;
      state.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
      yield* Effect.tryPromise({
        try: () => state.client.stop(),
        catch: () => undefined,
      }).pipe(Effect.ignore);
    });

  const cancelIdleCloseFiber = (state: SharedCopilotTextClientState) =>
    Effect.gen(function* () {
      const idleCloseFiber = state.idleCloseFiber;
      state.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
    });

  const scheduleIdleClose = (clientKey: string, state: SharedCopilotTextClientState) =>
    Effect.gen(function* () {
      yield* cancelIdleCloseFiber(state);
      const fiber = yield* Effect.sleep(COPILOT_TEXT_GENERATION_IDLE_TTL).pipe(
        Effect.andThen(
          sharedClientMutex.withPermit(
            Effect.gen(function* () {
              const current = sharedClients.get(clientKey);
              if (!current || current !== state || current.activeRequests > 0) {
                return;
              }

              current.idleCloseFiber = null;
              yield* closeSharedClient(clientKey);
            }),
          ),
        ),
        Effect.forkIn(idleFiberScope),
      );
      state.idleCloseFiber = fiber;
    });

  const acquireSharedClient = (input: {
    readonly operation: CopilotTextGenerationOperation;
    readonly cwd: string;
    readonly settings: CopilotSettings;
  }): Effect.Effect<SharedCopilotTextClientLease, TextGenerationError> =>
    Effect.gen(function* () {
      const clientKey = copilotTextClientKey({
        settings: input.settings,
        cwd: input.cwd,
      });

      const client = yield* sharedClientMutex.withPermit(
        Effect.gen(function* () {
          const existing = sharedClients.get(clientKey);
          if (existing) {
            yield* cancelIdleCloseFiber(existing);
            existing.activeRequests += 1;
            return existing.client;
          }

          const client = yield* Effect.try({
            try: () =>
              createCopilotClient({
                settings: input.settings,
                cwd: input.cwd,
                ...(options?.baseDirectory ? { baseDirectory: options.baseDirectory } : {}),
                env: environment,
                logLevel: "error",
              }),
            catch: (cause) =>
              copilotTextGenerationError(
                input.operation,
                detailFromCause(cause, "Failed to configure Copilot client."),
                cause,
              ),
          });
          yield* Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) =>
              copilotTextGenerationError(
                input.operation,
                detailFromCause(cause, "Failed to start Copilot client."),
                cause,
              ),
          });

          sharedClients.set(clientKey, {
            client,
            activeRequests: 1,
            idleCloseFiber: null,
          });
          return client;
        }),
      );

      return { clientKey, client };
    });

  const releaseSharedClient = (lease: SharedCopilotTextClientLease) =>
    sharedClientMutex.withPermit(
      Effect.gen(function* () {
        const state = sharedClients.get(lease.clientKey);
        if (!state || state.client !== lease.client) {
          return;
        }

        state.activeRequests = Math.max(0, state.activeRequests - 1);
        if (state.activeRequests === 0) {
          yield* scheduleIdleClose(lease.clientKey, state);
        }
      }),
    );

  yield* Effect.addFinalizer(() =>
    sharedClientMutex.withPermit(
      Effect.forEach([...sharedClients.keys()], (clientKey) => closeSharedClient(clientKey), {
        discard: true,
      }),
    ),
  );

  const runCopilotJson = <S extends Schema.Top>(input: {
    readonly operation: CopilotTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      if (!settings.enabled) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Copilot is disabled in server settings.",
        });
      }

      const fileAttachments = (input.attachments ?? [])
        .map((attachment) => {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          return path
            ? {
                type: "file" as const,
                path,
                displayName: attachment.name,
              }
            : null;
        })
        .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);
      const reasoningEffort = getModelSelectionStringOptionValue(
        input.modelSelection,
        "reasoningEffort",
      ) as CopilotReasoningEffort | undefined;

      // Keep request state isolated per generation call while reusing the
      // started SDK client so git helpers do not respawn the Copilot CLI.
      const rawContent = yield* Effect.acquireUseRelease(
        acquireSharedClient({
          operation: input.operation,
          cwd: input.cwd,
          settings,
        }),
        ({ client }) =>
          Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () =>
                client.createSession({
                  clientName: "t3-code-git-text",
                  model: input.modelSelection.model,
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                  workingDirectory: input.cwd,
                  streaming: false,
                  availableTools: [],
                  enableConfigDiscovery: false,
                  onPermissionRequest: () => ({
                    kind: "denied-no-approval-rule-and-could-not-request-from-user",
                  }),
                }),
              catch: (cause) =>
                copilotTextGenerationError(
                  input.operation,
                  detailFromCause(cause, "Failed to create Copilot session."),
                  cause,
                ),
            }),
            (session: CopilotSession) =>
              Effect.tryPromise({
                try: async () => {
                  const response = await session.sendAndWait(
                    {
                      prompt: copilotJsonPrompt(input.prompt, input.outputSchemaJson),
                      ...(fileAttachments.length > 0 ? { attachments: fileAttachments } : {}),
                    },
                    COPILOT_TIMEOUT_MS,
                  );
                  return response?.data.content.trim() ?? "";
                },
                catch: (cause) =>
                  copilotTextGenerationError(
                    input.operation,
                    detailFromCause(cause, "Copilot text generation request failed."),
                    cause,
                  ),
              }),
            (session) =>
              Effect.tryPromise({
                try: () => session.disconnect(),
                catch: () => undefined,
              }).pipe(Effect.ignore),
          ),
        releaseSharedClient,
      );

      if (rawContent.length === 0) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Copilot returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawContent)).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "Copilot returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Copilot text generation request failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runCopilotJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...(input.includeBranch && "branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(sanitizeBranchFragment(generated.branch)) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CopilotTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runCopilotJson({
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

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CopilotTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      branch: sanitizeFeatureBranchName(sanitizeBranchFragment(generated.branch)),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
