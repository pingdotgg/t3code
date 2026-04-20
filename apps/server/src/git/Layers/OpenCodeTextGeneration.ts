import { Duration, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  TextGenerationError,
  type ChatAttachment,
  type OpenCodeModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import {
  createOpenCodeSdkClient,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
  parseOpenCodeModelSlug,
  startOpenCodeServerProcess,
  toOpenCodeFileParts,
} from "../../provider/opencodeRuntime.ts";

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

function getOpenCodePromptErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return message;
  }

  if ("name" in error && typeof error.name === "string") {
    const name = error.name.trim();
    return name.length > 0 ? name : null;
  }

  return null;
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      if (!("type" in part) || part.type !== "text") {
        return [];
      }
      if (!("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
}

interface SharedOpenCodeTextGenerationServerState {
  server: OpenCodeServerProcess | null;
  binaryPath: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

const makeOpenCodeTextGeneration = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const sharedServerMutex = yield* Semaphore.make(1);
  const sharedServerState: SharedOpenCodeTextGenerationServerState = {
    server: null,
    binaryPath: null,
    activeRequests: 0,
    idleCloseFiber: null,
  };

  const closeSharedServer = (server: OpenCodeServerProcess) => {
    if (sharedServerState.server === server) {
      sharedServerState.server = null;
      sharedServerState.binaryPath = null;
    }
    server.close();
  };

  const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
    const idleCloseFiber = sharedServerState.idleCloseFiber;
    sharedServerState.idleCloseFiber = null;
    if (idleCloseFiber !== null) {
      yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
    }
  });

  const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
    server: OpenCodeServerProcess,
  ) {
    yield* cancelIdleCloseFiber();
    const fiber = yield* Effect.sleep(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS)).pipe(
      Effect.andThen(
        sharedServerMutex.withPermit(
          Effect.sync(() => {
            if (sharedServerState.server !== server || sharedServerState.activeRequests > 0) {
              return;
            }
            sharedServerState.idleCloseFiber = null;
            closeSharedServer(server);
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
            closeSharedServer(existingServer);
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

        const server = yield* Effect.tryPromise({
          try: () => startOpenCodeServerProcess({ binaryPath: input.binaryPath }),
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: cause instanceof Error ? cause.message : "Failed to start OpenCode server.",
              cause,
            }),
        });

        sharedServerState.server = server;
        sharedServerState.binaryPath = input.binaryPath;
        sharedServerState.activeRequests = 1;
        return server;
      }),
    );

  const releaseSharedServer = (server: OpenCodeServerProcess) =>
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

  yield* Effect.addFinalizer(() =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();
        const server = sharedServerState.server;
        sharedServerState.server = null;
        sharedServerState.binaryPath = null;
        sharedServerState.activeRequests = 0;
        if (server !== null) {
          server.close();
        }
      }),
    ),
  );

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: OpenCodeModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.map(
        (value) =>
          value.providers?.opencode ?? {
            enabled: true,
            binaryPath: "opencode",
            serverUrl: "",
            serverPassword: "",
            customModels: [],
          },
      ),
      Effect.orElseSucceed(() => ({
        enabled: true,
        binaryPath: "opencode",
        serverUrl: "",
        serverPassword: "",
        customModels: [],
      })),
    );

    const fileParts = toOpenCodeFileParts({
      attachments: input.attachments,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const runAgainstServer = (server: Pick<OpenCodeServerConnection, "url">) =>
      Effect.tryPromise({
        try: async () => {
          const client = createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: input.cwd,
            ...(settings.serverUrl.length > 0 && settings.serverPassword
              ? { serverPassword: settings.serverPassword }
              : {}),
          });
          const session = await client.session.create({
            title: `T3 Code ${input.operation}`,
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          });
          if (!session.data) {
            throw new Error("OpenCode session.create returned no session payload.");
          }

          const result = await client.session.prompt({
            sessionID: session.data.id,
            model: parsedModel,
            ...(input.modelSelection.options?.agent
              ? { agent: input.modelSelection.options.agent }
              : {}),
            ...(input.modelSelection.options?.variant
              ? { variant: input.modelSelection.options.variant }
              : {}),
            parts: [{ type: "text", text: input.prompt }, ...fileParts],
          });
          const info = result.data?.info;
          const errorMessage = getOpenCodePromptErrorMessage(info?.error);
          if (errorMessage) {
            throw new Error(errorMessage);
          }
          const rawText = getOpenCodeTextResponse(result.data?.parts);
          if (rawText.length === 0) {
            throw new Error("OpenCode returned empty output.");
          }
          return rawText;
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail:
              cause instanceof Error ? cause.message : "OpenCode text generation request failed.",
            cause,
          }),
      });

    const rawOutput =
      settings.serverUrl.length > 0
        ? yield* runAgainstServer({ url: settings.serverUrl })
        : yield* Effect.acquireUseRelease(
            acquireSharedServer({
              binaryPath: settings.binaryPath,
              operation: input.operation,
            }),
            runAgainstServer,
            releaseSharedServer,
          );

    return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
      extractJsonObject(rawOutput),
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpenCodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

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

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "OpenCodeTextGeneration.generatePrContent",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

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

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OpenCodeTextGeneration.generateBranchName",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

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

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpenCodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

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
  } satisfies TextGenerationShape;
});

export const OpenCodeTextGenerationLive = Layer.effect(TextGeneration, makeOpenCodeTextGeneration);
