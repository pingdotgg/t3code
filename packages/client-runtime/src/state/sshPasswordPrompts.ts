import {
  WS_METHODS,
  type EnvironmentId,
  type SourceControlSshPasswordPromptRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";

import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";

export type SshPasswordPromptHandler = (
  request: SourceControlSshPasswordPromptRequest,
) => Promise<string | null>;

export type SshPromptedOperationEvent<Result> =
  | {
      readonly _tag: "ssh_password_prompt";
      readonly request: SourceControlSshPasswordPromptRequest;
    }
  | { readonly _tag: "complete"; readonly result: Result };

export const resolveSshPasswordPrompt = (
  promptRequest: SourceControlSshPasswordPromptRequest,
  onSshPasswordPrompt: SshPasswordPromptHandler,
) =>
  Effect.tryPromise({
    try: () => onSshPasswordPrompt(promptRequest),
    catch: () => null,
  }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.flatMap((password) =>
      request(WS_METHODS.sourceControlResolveSshPasswordPrompt, {
        requestId: promptRequest.requestId,
        password,
      }),
    ),
  );

export const consumeSshPromptedOperation = <Result, Error, Requirements>(
  environmentId: EnvironmentId,
  operation: string,
  stream: Stream.Stream<SshPromptedOperationEvent<Result>, Error, Requirements>,
  onSshPasswordPrompt: SshPasswordPromptHandler,
) =>
  Effect.gen(function* () {
    type ResolutionError = Effect.Error<ReturnType<typeof resolveSshPasswordPrompt>>;
    const resolutionFailed = yield* Deferred.make<never, ResolutionError>();
    const consume = stream.pipe(
      Stream.mapEffect((event) => {
        if (event._tag === "complete") {
          return Effect.succeed(event.result);
        }
        return resolveSshPasswordPrompt(event.request, onSshPasswordPrompt).pipe(
          Effect.tapError((error) => Deferred.fail(resolutionFailed, error)),
          Effect.forkChild({ startImmediately: true }),
          Effect.as(null),
        );
      }),
      Stream.runFold(
        () => null as Result | null,
        (current, next) => next ?? current,
      ),
    );
    const result = yield* Effect.raceFirst(consume, Deferred.await(resolutionFailed));
    if (result === null) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId,
        message: `${operation} ended before the server returned a result.`,
      });
    }
    return result;
  });
