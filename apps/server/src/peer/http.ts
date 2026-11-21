import {
  CommandId,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerClientPairing from "./PeerClientPairing.ts";

// The response is a credential.
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

/**
 * A link session is accepted on `/mcp` and here, nowhere else. These are routes and not MCP
 * tools so that no agent's tool list can hold them: thread credentials never authenticate here.
 */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "peerLink",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const issuer = yield* PeerClientPairing.PeerClientPairingIssuer;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const random = yield* SecureRandom.SecureRandom;

    const linkCaller = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // A browser never holds a link's token; refuse one before reading credentials, as `/mcp` does.
      if (request.headers.origin !== undefined) {
        return yield* new EnvironmentHttpForbiddenError({
          message: "This route does not accept browser requests.",
        });
      }
      return yield* auth.authenticateMcpClient(request).pipe(
        Effect.mapError((error) =>
          EnvironmentAuth.isServerAuthCredentialError(error)
            ? new EnvironmentHttpUnauthorizedError({
                message: "Only a linked environment's session is accepted here.",
              })
            : new EnvironmentHttpInternalServerError({
                message: "The session could not be checked.",
              }),
        ),
      );
    });

    const internal = (message: string) => () => new EnvironmentHttpInternalServerError({ message });

    return handlers
      .handle(
        "clientPairing",
        Effect.fn("environment.peerLink.clientPairing")(function* (args) {
          yield* noStore;
          const caller = yield* linkCaller;
          return yield* issuer.issue(caller, args.payload).pipe(
            Effect.catchTags({
              PeerClientPairingRefused: (error) =>
                Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            }),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (cause) =>
              Effect.logError("Could not mint a client pairing for a linked environment.", {
                cause,
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new EnvironmentHttpInternalServerError({
                      message: "The pairing could not be created.",
                    }),
                  ),
                ),
              ),
            ),
          );
        }),
      )
      .handle(
        "parentDone",
        Effect.fn("environment.peerLink.parentDone")(function* (args) {
          const caller = yield* linkCaller;
          // The environment the link was paired as, never one a request names.
          const environmentId = caller.peerLink ? caller.peerEnvironmentId : undefined;
          if (environmentId === undefined) {
            return yield* new EnvironmentHttpUnauthorizedError({
              message: "Only a link paired by this version names its environment. Link it again.",
            });
          }
          const shell = yield* threads
            .getThreadShell(args.payload.threadId)
            .pipe(Effect.mapError(internal("The thread could not be read.")));
          if (shell === null) return { outcome: "thread_not_found" as const };
          yield* threads
            .dispatch({
              type: "thread.delegated-from.parent-done",
              commandId: CommandId.make(`command:peer-parent-done:${yield* random.uuidV4()}`),
              threadId: shell.id,
              parent: {
                environmentId: EnvironmentId.make(environmentId),
                threadId: args.payload.parentThreadId,
              },
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "OrchestratorDispatchError"
                  ? new EnvironmentHttpForbiddenError({
                      message: "That thread is not a task this environment's thread delegated.",
                    })
                  : new EnvironmentHttpInternalServerError({
                      message: "The thread could not be updated.",
                    }),
              ),
            );
          return { outcome: "marked" as const };
        }),
      );
  }),
);
