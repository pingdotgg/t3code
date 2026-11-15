// Generate endpoints return 403 on the free tier; use and remove a temporary prompt session.
import { AbsolutePath, Location, Model, Provider, Session } from "@opencode/client/effect";
import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as NodeURL from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { isProviderNativeImageAttachment } from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as BlindEvaluation from "../blindEvaluation.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

const GENERATION_TIMEOUT = "3 minutes";

// Free models refuse denied read/shell permissions; ask and reject requests as they arrive.
const GENERATION_PERMISSIONS = [{ action: "*", resource: "*", effect: "ask" }] as const;

// Provider error text stays in cause, outside detail.
type Outcome =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "failed"; readonly detail: string; readonly cause?: unknown };

const runOnServer = Effect.fn("Opencode2TextGeneration.runOnServer")(function* (
  connection: OpenCode2Server.OpenCode2Connection,
  input: TextGenerationOperations.Request<Schema.Top>,
) {
  const { resolveAttachmentPath } = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const blindEvaluation = input.operation === "generateModelEvaluation";
  const { client } = connection;
  const parsed = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
  if (parsed === null) {
    return yield* new TextGenerationError({
      operation: input.operation,
      detail: "OpenCode model selection must use the 'provider/model' format.",
    });
  }
  const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
  const outcome = yield* Deferred.make<Outcome>();
  let sessionId: string | undefined;
  let executionModelMatched = !blindEvaluation;
  const texts = new Map<string, string>();
  const successfulOutcome = (): Outcome =>
    executionModelMatched
      ? { _tag: "text", text: [...texts.values()].join("\n").trim() }
      : {
          _tag: "failed",
          detail: "OpenCode did not confirm the requested model and variant for blind evaluation.",
        };
  // Subscribed first: the stream is volatile, and the reply arrives on it.
  const events = yield* connection.events;
  yield* events.pipe(
    Stream.runForEach((event) => {
      // An execution end a newer server sent in a shape this build cannot
      // read still ends the generation, as it ends a turn in the adapter.
      if (event.type === "unreadable.execution.ended") {
        if (event.sessionID !== sessionId) return Effect.void;
        return Deferred.succeed(
          outcome,
          event.executionType === "session.execution.succeeded"
            ? successfulOutcome()
            : {
                _tag: "failed" as const,
                detail: "OpenCode ended the generation in a way this version cannot read.",
                cause: event,
              },
        );
      }
      if (
        sessionId === undefined ||
        !("data" in event) ||
        !("sessionID" in event.data) ||
        event.data.sessionID !== sessionId
      ) {
        return Effect.void;
      }
      if (blindEvaluation && event.type.startsWith("session.tool.")) {
        return Deferred.succeed(outcome, {
          _tag: "failed",
          detail: "OpenCode reported tool activity during blind evaluation.",
          cause: event,
        });
      }
      switch (event.type) {
        case "session.step.started": {
          if (!blindEvaluation) return Effect.void;
          const model = event.data.model;
          if (
            model.providerID !== parsed.providerID ||
            model.id !== parsed.modelID ||
            (variant !== undefined && model.variant !== variant)
          ) {
            return Deferred.succeed(outcome, {
              _tag: "failed",
              detail: "OpenCode executed blind evaluation with a different model or variant.",
              cause: event,
            });
          }
          executionModelMatched = true;
          return Effect.void;
        }
        case "session.step.ended":
          if (blindEvaluation && event.data.finish === "tool-calls") {
            return Deferred.succeed(outcome, {
              _tag: "failed",
              detail: "OpenCode reported tool activity during blind evaluation.",
              cause: event,
            });
          }
          return Effect.void;
        case "session.text.ended":
          texts.set(`${event.data.assistantMessageID}:${event.data.ordinal}`, event.data.text);
          return Effect.void;
        case "permission.asked":
          return client.permission
            .reply({
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              decision: "reject",
              message: "Tools are not available while generating text.",
            })
            .pipe(
              Effect.ignore({ log: true }),
              Effect.andThen(
                blindEvaluation
                  ? Deferred.succeed(outcome, {
                      _tag: "failed",
                      detail: "OpenCode requested tool permission during blind evaluation.",
                      cause: event,
                    })
                  : Effect.void,
              ),
            );
        case "session.execution.succeeded":
          return Deferred.succeed(outcome, successfulOutcome());
        case "session.execution.failed":
          return Deferred.succeed(outcome, {
            _tag: "failed",
            detail: "OpenCode could not generate the text.",
            cause: event.data.error,
          });
        case "session.execution.interrupted":
          return Deferred.succeed(outcome, {
            _tag: "failed",
            detail: "OpenCode stopped the generation.",
          });
        default:
          return Effect.void;
      }
    }),
    // The reply only arrives on this stream, so a lost stream ends the wait.
    Effect.exit,
    Effect.flatMap((exit) =>
      Deferred.succeed(outcome, {
        _tag: "failed",
        detail: "The OpenCode event stream was lost.",
        cause: exit,
      }),
    ),
    Effect.forkScoped,
  );
  // The limit covers creating the session and sending the prompt as well, since
  // either request can stall while the event stream stays connected.
  const generate = Effect.gen(function* () {
    const session = yield* client.session.create({
      title: `T3 Code ${input.operation}`,
      location: Location.PublicRef.make({ directory: AbsolutePath.make(input.cwd) }),
      model: Model.Ref.make({
        providerID: Provider.ID.make(parsed.providerID),
        id: Model.ID.make(parsed.modelID),
        ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
      }),
      permissions: blindEvaluation
        ? [{ action: "*", resource: "*", effect: "deny" as const }]
        : GENERATION_PERMISSIONS,
    });
    sessionId = session.id;
    yield* Effect.addFinalizer(() =>
      client.session
        .remove({ sessionID: session.id })
        .pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true })),
    );
    const images: Array<{ uri: string; name: string }> = [];
    // As in the adapter: an external server may not share T3's attachment directory, and
    // OpenCode rejects the whole prompt if an attached file is missing.
    for (const attachment of connection.external ? [] : (input.attachments ?? [])) {
      if (!isProviderNativeImageAttachment(attachment)) continue;
      const path = resolveAttachmentPath(attachment);
      if (path === null) continue;
      const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
      if (exists) images.push({ uri: NodeURL.pathToFileURL(path).href, name: attachment.name });
    }
    yield* client.session.prompt({
      sessionID: session.id,
      text: input.prompt,
      ...(images.length === 0 ? {} : { files: images }),
    });
    return yield* Deferred.await(outcome);
  });
  const result = yield* generate.pipe(
    Effect.timeoutOrElse({
      duration: GENERATION_TIMEOUT,
      orElse: () =>
        (sessionId === undefined
          ? Effect.void
          : client.session
              .interrupt({ sessionID: Session.ID.make(sessionId) })
              .pipe(Effect.timeout("5 seconds"), Effect.ignore)
        ).pipe(
          Effect.as<Outcome>({
            _tag: "failed",
            detail: "OpenCode did not finish generating in time.",
          }),
        ),
    }),
  );
  if (result._tag === "failed") {
    return yield* new TextGenerationError({
      operation: input.operation,
      detail: result.detail,
      ...(result.cause === undefined ? {} : { cause: result.cause }),
    });
  }
  if (result.text.length === 0) {
    return yield* new TextGenerationError({
      operation: input.operation,
      detail: "OpenCode returned empty output.",
    });
  }
  return result.text;
}, Effect.scoped);

export const make = Effect.fn("OpenCode2TextGeneration.make")(function* (
  options: {
    readonly binaryPath?: string;
    readonly serverUrl?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly directory?: string;
  } = {},
) {
  const binaryPath = options.binaryPath ?? "opencode";
  const processEnvironment = options.environment ?? process.env;
  const processDirectory = options.directory ?? process.cwd();
  const server = yield* OpenCode2Server.OpenCode2Server;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const openCode2Client = yield* OpenCode2Client.OpenCode2Client;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const host = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const runIsolated = Effect.fn("OpenCode2TextGeneration.runIsolated")(function* <
    S extends Schema.Top,
  >(input: TextGenerationOperations.Request<S>) {
    const environment = yield* BlindEvaluation.makeBlindEvaluationEnvironment({
      generation: "v2",
      operation: input.operation,
      directory: processDirectory,
      environment: processEnvironment,
    });
    const isolatedServer = yield* OpenCode2Server.make({
      binaryPath,
      serverUrl: "",
      serverPassword: "",
      directory: input.cwd,
      environment,
    });
    const raw = yield* isolatedServer.withConnection((connection) =>
      runOnServer(connection, input),
    );
    return yield* TextGenerationOperations.decodeJsonReply(input, "OpenCode", raw);
  }, Effect.scoped);
  const run: TextGenerationOperations.Runner = (input) => {
    const blindEvaluation = input.operation === "generateModelEvaluation";
    const generated = blindEvaluation
      ? BlindEvaluation.validateBlindEvaluationSelection(
          input.modelSelection,
          input.operation,
        ).pipe(Effect.andThen(runIsolated(input)))
      : server
          .withConnection((connection) => runOnServer(connection, input))
          .pipe(
            Effect.flatMap((raw) =>
              TextGenerationOperations.decodeJsonReply(input, "OpenCode", raw),
            ),
          );
    return generated.pipe(
      Effect.provideService(ProviderHost.ProviderHost, host),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      Effect.provideService(OpenCode2Client.OpenCode2Client, openCode2Client),
      Effect.provideService(SecureRandom.SecureRandom, secureRandom),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode text generation failed.",
              cause,
            }),
      ),
    );
  };
  return TextGenerationOperations.fromRunner("OpenCode2TextGeneration", run, {
    supportsInvestigation: false,
    supportsBlindEvaluation: !options.serverUrl?.trim(),
  });
});
