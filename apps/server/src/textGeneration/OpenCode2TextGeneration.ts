import type { ModelRef, OpencodeClient } from "@opencode-ai/sdk-next/v2";
import {
  TextGenerationError,
  type ModelSelection,
  type OpenCode2Settings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { parseOpenCodeModelSlug } from "../provider/opencodeRuntime.ts";
import * as OpenCode2Runtime from "../provider/opencode2Runtime.ts";
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

const OPENCODE2_TEXT_GENERATION_IDLE_TTL = "30 seconds";
const OPENCODE2_TEXT_GENERATION_MODEL_RETRY_DELAY = "500 millis";
const OPENCODE2_TEXT_GENERATION_MODEL_MAX_ATTEMPTS = 5;

const OpenCode2TextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
]);
type OpenCode2TextGenerationOperation = typeof OpenCode2TextGenerationOperation.Type;

const OpenCode2GenerateResponse = Schema.Struct({
  data: Schema.Struct({
    data: Schema.Struct({
      text: Schema.String,
    }),
  }),
});

const OpenCode2SessionCreateResponse = Schema.Struct({
  data: Schema.Struct({
    data: Schema.Struct({
      id: Schema.String,
    }),
  }),
});
const decodeOpenCode2GenerateResponse = Schema.decodeUnknownEffect(OpenCode2GenerateResponse);
const decodeOpenCode2SessionCreateResponse = Schema.decodeUnknownEffect(
  OpenCode2SessionCreateResponse,
);

interface SharedOpenCode2TextGenerationServerState {
  server: OpenCode2Runtime.OpenCode2ServerProcess | null;
  serverScope: Scope.Closeable | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

function modelRefFor(
  operation: OpenCode2TextGenerationOperation,
  modelSelection: ModelSelection,
): Effect.Effect<ModelRef, TextGenerationError> {
  const parsed = parseOpenCodeModelSlug(modelSelection.model);
  if (parsed === null) {
    return Effect.fail(
      new TextGenerationError({
        operation,
        detail: "OpenCode 2 model selection must use the 'provider/model' format.",
      }),
    );
  }
  const variant = OpenCode2Runtime.normalizeOpenCode2Variant(
    getModelSelectionStringOptionValue(modelSelection, "variant"),
  );
  return Effect.succeed({
    id: parsed.modelID,
    providerID: parsed.providerID,
    ...(variant === undefined ? {} : { variant }),
  });
}

function isOpenCode2ModelStartupError(error: TextGenerationError): boolean {
  return (
    OpenCode2Runtime.isOpenCode2RuntimeError(error.cause) &&
    error.cause.category === "model-unavailable"
  );
}

export const makeOpenCode2TextGeneration = Effect.fn("makeOpenCode2TextGeneration")(function* (
  settings: OpenCode2Settings,
  environment?: NodeJS.ProcessEnv,
) {
  const runtime = yield* OpenCode2Runtime.OpenCode2Runtime;
  const resolvedEnvironment = environment ?? process.env;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const sharedServerMutex = yield* Semaphore.make(1);
  const sharedServerState: SharedOpenCode2TextGenerationServerState = {
    server: null,
    serverScope: null,
    activeRequests: 0,
    idleCloseFiber: null,
  };

  const closeSharedServer = Effect.fn("OpenCode2TextGeneration.closeSharedServer")(function* () {
    const scope = sharedServerState.serverScope;
    sharedServerState.server = null;
    sharedServerState.serverScope = null;
    sharedServerState.activeRequests = 0;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const cancelIdleCloseFiber = Effect.fn("OpenCode2TextGeneration.cancelIdleCloseFiber")(
    function* () {
      const idleCloseFiber = sharedServerState.idleCloseFiber;
      sharedServerState.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
    },
  );

  const scheduleIdleClose = Effect.fn("OpenCode2TextGeneration.scheduleIdleClose")(function* (
    server: OpenCode2Runtime.OpenCode2ServerProcess,
  ) {
    yield* cancelIdleCloseFiber();
    sharedServerState.idleCloseFiber = yield* Effect.sleep(OPENCODE2_TEXT_GENERATION_IDLE_TTL).pipe(
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
  });

  const acquireSharedServer = (
    operation: OpenCode2TextGenerationOperation,
  ): Effect.Effect<OpenCode2Runtime.OpenCode2ServerProcess, TextGenerationError> =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();
        const existingServer = sharedServerState.server;
        if (existingServer !== null) {
          const isRunning = yield* existingServer.isRunning;
          if (isRunning) {
            sharedServerState.activeRequests += 1;
            return existingServer;
          }
          yield* closeSharedServer();
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              restore(
                runtime
                  .startOpenCode2ServerProcess({
                    binaryPath: settings.binaryPath,
                    environment: resolvedEnvironment,
                  })
                  .pipe(
                    Effect.provideService(Scope.Scope, serverScope),
                    Effect.mapError(
                      (cause) =>
                        new TextGenerationError({
                          operation,
                          detail: "OpenCode 2 server startup failed.",
                          cause,
                        }),
                    ),
                  ),
              ),
            );
            if (Exit.isFailure(startedExit)) {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            sharedServerState.server = startedExit.value;
            sharedServerState.serverScope = serverScope;
            sharedServerState.activeRequests = 1;
            return startedExit.value;
          }),
        );
      }),
    );

  const releaseSharedServer = (server: OpenCode2Runtime.OpenCode2ServerProcess) =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        if (sharedServerState.server !== server) return;
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
        yield* closeSharedServer();
      }),
    ),
  );

  const sdkCall = <A>(
    operation: OpenCode2TextGenerationOperation,
    method: OpenCode2Runtime.OpenCode2RuntimeOperation,
    call: () => Promise<A>,
  ): Effect.Effect<A, TextGenerationError> =>
    OpenCode2Runtime.runOpenCode2Sdk(method, call).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `OpenCode 2 ${method} request failed.`,
            cause,
          }),
      ),
    );

  const retryModelStartup = <A>(
    effect: () => Effect.Effect<A, TextGenerationError>,
    attempt = 1,
  ): Effect.Effect<A, TextGenerationError> =>
    effect().pipe(
      Effect.catch((error) =>
        attempt < OPENCODE2_TEXT_GENERATION_MODEL_MAX_ATTEMPTS &&
        isOpenCode2ModelStartupError(error)
          ? Effect.sleep(OPENCODE2_TEXT_GENERATION_MODEL_RETRY_DELAY).pipe(
              Effect.andThen(retryModelStartup(effect, attempt + 1)),
            )
          : Effect.fail(error),
      ),
    );

  const decodeGenerateText = Effect.fn("OpenCode2TextGeneration.decodeGenerateText")(function* (
    operation: OpenCode2TextGenerationOperation,
    response: unknown,
  ) {
    const decoded = yield* decodeOpenCode2GenerateResponse(response).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "OpenCode 2 returned an invalid generation response.",
            cause,
          }),
      ),
    );
    const text = decoded.data.data.text.trim();
    if (text.length === 0) {
      return yield* new TextGenerationError({
        operation,
        detail: "OpenCode 2 returned empty output.",
      });
    }
    return text;
  });

  const generateWithSessionAgent = Effect.fn("OpenCode2TextGeneration.generateWithSessionAgent")(
    function* (input: {
      readonly client: OpencodeClient;
      readonly operation: OpenCode2TextGenerationOperation;
      readonly cwd: string;
      readonly prompt: string;
      readonly model: ModelRef;
      readonly agent: string;
    }) {
      const createResponse = yield* sdkCall(input.operation, "session.create", () =>
        input.client.v2.session.create({
          model: input.model,
          location: { directory: input.cwd },
          agent: input.agent,
        }),
      );
      const created = yield* decodeOpenCode2SessionCreateResponse(createResponse).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode 2 returned an invalid session creation response.",
              cause,
            }),
        ),
      );
      const sessionID = created.data.data.id;

      return yield* Effect.gen(function* () {
        const response = yield* sdkCall(input.operation, "session.generate", () =>
          input.client.v2.session.generate({
            sessionID,
            prompt: input.prompt,
          }),
        );
        return yield* decodeGenerateText(input.operation, response);
      }).pipe(
        Effect.ensuring(
          sdkCall(input.operation, "session.remove", () =>
            input.client.v2.session.remove({ sessionID }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to remove temporary OpenCode 2 text generation session.", {
                sessionID,
                cause,
              }),
            ),
          ),
        ),
      );
    },
  );

  const runOpenCode2Json = Effect.fn("OpenCode2TextGeneration.runOpenCode2Json")(function* <
    S extends Schema.Top,
  >(input: {
    readonly operation: OpenCode2TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }) {
    const model = yield* modelRefFor(input.operation, input.modelSelection);
    const agent = getModelSelectionStringOptionValue(input.modelSelection, "agent");

    const runAgainstServer = Effect.fn("OpenCode2TextGeneration.runAgainstServer")(function* (
      server: OpenCode2Runtime.OpenCode2ServerCredentials,
    ) {
      const client = runtime.createOpenCode2SdkClient({
        baseUrl: server.url,
        directory: input.cwd,
        serverPassword: server.password,
      });
      return yield* retryModelStartup(() =>
        agent !== undefined
          ? generateWithSessionAgent({
              client,
              operation: input.operation,
              cwd: input.cwd,
              prompt: input.prompt,
              model,
              agent,
            })
          : sdkCall(input.operation, "generate.text", () =>
              client.v2.generate.text({
                location: { directory: input.cwd },
                prompt: input.prompt,
                model,
              }),
            ).pipe(Effect.flatMap((response) => decodeGenerateText(input.operation, response))),
      );
    });

    const rawOutput =
      settings.serverUrl.length > 0
        ? yield* runtime
            .connectToOpenCode2Server({
              binaryPath: settings.binaryPath,
              serverUrl: settings.serverUrl,
              serverPassword: settings.serverPassword,
              environment: resolvedEnvironment,
            })
            .pipe(
              Effect.provideService(Scope.Scope, idleFiberScope),
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation: input.operation,
                    detail: "OpenCode 2 server connection failed.",
                    cause,
                  }),
              ),
              Effect.flatMap(runAgainstServer),
            )
        : yield* Effect.acquireUseRelease(
            acquireSharedServer(input.operation),
            runAgainstServer,
            releaseSharedServer,
          );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode 2 returned invalid structured output.",
            cause,
          }),
      ),
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
      const generated = yield* runOpenCode2Json({
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
        changeRequestTemplate: input.changeRequestTemplate,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
      });
      const generated = yield* runOpenCode2Json({
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
      const generated = yield* runOpenCode2Json({
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
        attachments: input.attachments,
        previousTitle: input.previousTitle,
      });
      const generated = yield* runOpenCode2Json({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
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
