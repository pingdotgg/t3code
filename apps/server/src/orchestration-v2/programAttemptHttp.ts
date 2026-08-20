import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProgramAttemptService from "./ProgramAttemptService.ts";

const mapProgramAttemptError = Effect.fn("programAttemptHttp.mapError")(function* (
  error: ProgramAttemptService.ProgramAttemptError,
) {
  switch (error.reason) {
    case "not_found":
      return yield* failEnvironmentNotFound("program_attempt_not_found");
    case "request_conflict":
      return yield* new EnvironmentHttpConflictError({ message: error.detail });
    case "launch_incomplete":
    case "run_missing":
    case "not_terminal":
      return yield* new EnvironmentHttpBadRequestError({ message: error.detail });
    case "persistence_failed":
    case "launch_failed":
    case "projection_failed":
    case "cancel_failed":
    case "invalid_record":
      return yield* failEnvironmentInternal("internal_error", error);
  }
});

export const programAttemptHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "programAttempts",
  Effect.fnUntraced(function* (handlers) {
    const attempts = yield* ProgramAttemptService.ProgramAttemptService;

    return handlers
      .handle(
        "launch",
        Effect.fn("environment.programAttempts.launch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* attempts.launch(args.payload).pipe(Effect.catch(mapProgramAttemptError));
        }),
      )
      .handle(
        "observe",
        Effect.fn("environment.programAttempts.observe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* attempts
            .observe(args.payload.attemptId)
            .pipe(Effect.catch(mapProgramAttemptError));
        }),
      )
      .handle(
        "observeThread",
        Effect.fn("environment.programAttempts.observeThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* attempts
            .observeThread(args.params.threadId)
            .pipe(Effect.catch(mapProgramAttemptError));
        }),
      )
      .handle(
        "cancel",
        Effect.fn("environment.programAttempts.cancel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* attempts.cancel(args.payload).pipe(Effect.catch(mapProgramAttemptError));
        }),
      )
      .handle(
        "acknowledge",
        Effect.fn("environment.programAttempts.acknowledge")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* attempts
            .acknowledge(args.payload)
            .pipe(Effect.catch(mapProgramAttemptError));
        }),
      );
  }),
);
