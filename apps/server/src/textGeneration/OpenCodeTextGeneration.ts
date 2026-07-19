import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

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

const OPENCODE_TEXT_GENERATION_IDLE_TTL = "30 seconds";

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

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedErrorClass<OpenCodeTextGenerationSessionRequestError>()(
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

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedErrorClass<OpenCodeTextGenerationSessionPayloadError>()(
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

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedErrorClass<OpenCodeTextGenerationPromptRequestError>()(
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

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedErrorClass<OpenCodeTextGenerationPromptResponseError>()(
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

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedErrorClass<OpenCodeTextGenerationEmptyOutputError>()(
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

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
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

interface SharedOpenCodeTextGenerationServerState {
  server: OpenCodeRuntime.OpenCodeServerProcess | null;
  /**
   * The scope that owns the shared server's lifetime. Closing this scope
   * terminates the OpenCode child process and interrupts any fibers the
   * runtime forked during startup. We don't hold a `close()` function on
   * the server handle anymore — the scope is the only lifecycle handle.
   */
  serverScope: Scope.Closeable | null;
  binaryPath: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const resolvedEnvironment = environment ?? process.env;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const sharedServerMutex = yield* Semaphore.make(1);
  const sharedServerState: SharedOpenCodeTextGenerationServerState = {
    server: null,
    serverScope: null,
    binaryPath: null,
    activeRequests: 0,
    idleCloseFiber: null,
  };

  const closeSharedServer = Effect.fn("closeSharedServer")(function* () {
    const scope = sharedServerState.serverScope;
    sharedServerState.server = null;
    sharedServerState.serverScope = null;
    sharedServerState.binaryPath = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
    const idleCloseFiber = sharedServerState.idleCloseFiber;
    sharedServerState.idleCloseFiber = null;
    if (idleCloseFiber !== null) {
      yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
    }
  });

  const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
    server: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    yield* cancelIdleCloseFiber();
    const fiber = yield* Effect.sleep(OPENCODE_TEXT_GENERATION_IDLE_TTL).pipe(
      Effect.andThen(
        sharedServerMutex.withPermit(
          Effect.gen(function* () {
            if (sharedServerState.server !== server || sharedServerState.activeRequests > 0) {
              return;
            }
            sharedServerState.idleCloseFiber = null;
            yield* closeSharedServer();
          }),
        ),
      ),
      Effect.forkIn(idleFiberScope),
    );
    sharedServerState.idleCloseFiber = fiber;
  });

  const acquireSharedServer = (input: {
    readonly binaryPath: string;
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
  }) =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();

        const existingServer = sharedServerState.server;
        if (existingServer !== null) {
          if (
            sharedServerState.binaryPath !== input.binaryPath &&
            sharedServerState.activeRequests === 0
          ) {
            yield* closeSharedServer();
          } else {
            if (sharedServerState.binaryPath !== input.binaryPath) {
              yield* Effect.logWarning(
                "OpenCode shared server binary path mismatch: requested " +
                  input.binaryPath +
                  " but active server uses " +
                  sharedServerState.binaryPath +
                  "; reusing existing server because there are active requests",
              );
            }
            sharedServerState.activeRequests += 1;
            return existingServer;
          }
        }

        // Create a fresh scope that owns this shared server. The runtime
        // will attach its child-process and fiber finalizers to this scope;
        // closing it kills the server and interrupts those fibers.
        //
        // The `Scope.make` / spawn / record-or-close transitions run inside
        // `uninterruptibleMask` so an interrupt arriving between any two
        // steps can't orphan the scope (and the child process attached to
        // it) before we either close it on failure or hand ownership to
        // `sharedServerState`. `restore` keeps the actual spawn
        // interruptible; an interrupt during the spawn is captured by
        // `Effect.exit` and drives us through the failure branch that
        // closes the fresh scope.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              restore(
                openCodeRuntime
                  .startOpenCodeServerProcess({
                    binaryPath: input.binaryPath,
                    environment: resolvedEnvironment,
                  })
                  .pipe(
                    Effect.provideService(Scope.Scope, serverScope),
                    Effect.mapError(
                      (cause) =>
                        new TextGenerationError({
                          operation: input.operation,
                          detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
                          cause,
                        }),
                    ),
                  ),
              ),
            );
            if (startedExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            const server = startedExit.value;
            sharedServerState.server = server;
            sharedServerState.serverScope = serverScope;
            sharedServerState.binaryPath = input.binaryPath;
            sharedServerState.activeRequests = 1;
            return server;
          }),
        );
      }),
    );

  const releaseSharedServer = (server: OpenCodeRuntime.OpenCodeServerProcess) =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        if (sharedServerState.server !== server) {
          return;
        }
        sharedServerState.activeRequests = Math.max(0, sharedServerState.activeRequests - 1);
        if (sharedServerState.activeRequests === 0) {
          yield* scheduleIdleClose(server);
        }
      }),
    );

  // Module-level finalizer: on layer shutdown, cancel the idle close fiber
  // and close the shared server scope. Consumers therefore cannot leak
  // the shared OpenCode server by forgetting to call anything.
  yield* Effect.addFinalizer(() =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();
        sharedServerState.activeRequests = 0;
        yield* closeSharedServer();
      }),
    ),
  );

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
      attachments: input.attachments,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
      function* (server: Pick<OpenCodeRuntime.OpenCodeServerConnection, "url">) {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: input.cwd,
          ...(openCodeSettings.serverUrl.length > 0 && openCodeSettings.serverPassword
            ? { serverPassword: openCodeSettings.serverPassword }
            : {}),
        });
        const session = yield* OpenCodeRuntime.runOpenCodeSdk("session.create", () =>
          client.session.create({
            title: `T3 Code ${input.operation}`,
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeTextGenerationSessionRequestError({
                operation: input.operation,
                cwd: input.cwd,
                cause: cause.cause,
              }),
          ),
        );
        if (!session.data) {
          return yield* new OpenCodeTextGenerationSessionPayloadError({
            operation: input.operation,
            cwd: input.cwd,
          });
        }
        const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
        const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const promptContext = {
          operation: input.operation,
          cwd: input.cwd,
          sessionId: session.data.id,
          providerId: parsedModel.providerID,
          modelId: parsedModel.modelID,
        };

        const result = yield* OpenCodeRuntime.runOpenCodeSdk("session.prompt", () =>
          client.session.prompt({
            sessionID: session.data.id,
            model: parsedModel,
            ...(selectedAgent ? { agent: selectedAgent } : {}),
            ...(selectedVariant ? { variant: selectedVariant } : {}),
            parts: [{ type: "text", text: input.prompt }, ...fileParts],
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeTextGenerationPromptRequestError({
                ...promptContext,
                cause: cause.cause,
              }),
          ),
        );
        const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
        if (promptFailure) {
          return yield* new OpenCodeTextGenerationPromptResponseError({
            ...promptContext,
            ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
            providerMessage: promptFailure.message,
          });
        }
        const responseParts = result.data?.parts ?? [];
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

    const rawOutput =
      openCodeSettings.serverUrl.length > 0
        ? yield* runAgainstServer({ url: openCodeSettings.serverUrl })
        : yield* Effect.acquireUseRelease(
            acquireSharedServer({
              binaryPath: openCodeSettings.binaryPath,
              operation: input.operation,
            }),
            runAgainstServer,
            releaseSharedServer,
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
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
