/**
 * Text generation on an OpenCode 2 server. Both of its `generate` endpoints
 * answer 403 on OpenCode's free tier ("free tier can only be used from within
 * OpenCode"), so each request runs as a prompt in a temporary session, as 1.x
 * does, and the session is removed afterwards.
 *
 * @module textGeneration/OpenCode2TextGeneration
 */
import { AbsolutePath, Location, Model, Provider, Session } from "@opencode/client/effect";
import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { OpenCode2Connection } from "../provider/opencode2/OpenCode2Server.ts";
import * as OpenCode2Server from "../provider/opencode2/OpenCode2Server.ts";
import { parseOpenCodeModelSlug } from "../provider/opencodeRuntime.ts";
import { makeOpenCodeOperations, type OpenCodeJsonRunner } from "./OpenCodeTextGeneration.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

/** A generation that takes this long is stuck; its session is stopped and removed. */
const GENERATION_TIMEOUT = "3 minutes";

/**
 * Nothing in a text generation needs a tool, so every tool asks and T3 is not
 * there to answer. Denying `shell` or `read` outright gets the whole session
 * refused on OpenCode's free models, and an ask that is never answered would
 * hang, so asks are rejected as they arrive.
 */
const GENERATION_PERMISSIONS = [{ action: "*", resource: "*", effect: "ask" }] as const;

/** How a generation ended. A failure's cause is the provider's own error, kept out of `detail`. */
type Outcome =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "failed"; readonly detail: string; readonly cause?: unknown };

const runOnServer = (
  connection: OpenCode2Connection,
  input: Parameters<OpenCodeJsonRunner>[0],
  attachmentsDir: string,
) =>
  Effect.gen(function* () {
    const { client } = connection;
    const parsed = parseOpenCodeModelSlug(input.modelSelection.model);
    if (parsed === null) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }
    const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
    const outcome = yield* Deferred.make<Outcome>();
    let sessionId: string | undefined;
    const texts = new Map<string, string>();
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
              ? { _tag: "text", text: [...texts.values()].join("\n").trim() }
              : {
                  _tag: "failed",
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
        switch (event.type) {
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
              .pipe(Effect.ignore({ log: true }));
          case "session.execution.succeeded":
            return Deferred.succeed(outcome, {
              _tag: "text",
              text: [...texts.values()].join("\n").trim(),
            });
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
    const session = yield* client.session.create({
      title: `T3 Code ${input.operation}`,
      location: Location.PublicRef.make({ directory: AbsolutePath.make(input.cwd) }),
      model: Model.Ref.make({
        providerID: Provider.ID.make(parsed.providerID),
        id: Model.ID.make(parsed.modelID),
        ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
      }),
      permissions: GENERATION_PERMISSIONS,
    });
    sessionId = session.id;
    yield* Effect.addFinalizer(() =>
      client.session
        .remove({ sessionID: session.id })
        .pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true })),
    );
    const images = (input.attachments ?? []).flatMap((attachment) => {
      if (attachment.type !== "image") return [];
      const path = resolveAttachmentPath({ attachmentsDir, attachment });
      return path === null ? [] : [{ uri: `file://${path}`, name: attachment.name }];
    });
    yield* client.session.prompt({
      sessionID: session.id,
      text: input.prompt,
      ...(images.length === 0 ? {} : { files: images }),
    });
    const result = yield* Deferred.await(outcome).pipe(
      Effect.timeoutOrElse({
        duration: GENERATION_TIMEOUT,
        orElse: () =>
          client.session.interrupt({ sessionID: Session.ID.make(session.id) }).pipe(
            Effect.ignore,
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
  }).pipe(Effect.scoped);

/** Text generation for an instance whose server is OpenCode 2. */
export const make = Effect.fn("OpenCode2TextGeneration.make")(function* () {
  const server = yield* OpenCode2Server.OpenCode2Server;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const run: OpenCodeJsonRunner = (input) => {
    // Each operation has its own output schema, as in 1.x.
    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return server
      .withConnection((connection) => runOnServer(connection, input, attachmentsDir))
      .pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "OpenCode text generation failed.",
                cause,
              }),
        ),
        Effect.flatMap((raw) =>
          decodeOutput(extractJsonObject(raw)).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: "OpenCode returned invalid structured output.",
                  cause,
                }),
            ),
          ),
        ),
      );
  };
  return makeOpenCodeOperations(run);
});
