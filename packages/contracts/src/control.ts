import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationDispatchCommandError,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

export const CONTROL_SEND_TEXT_MAX_CHARS = 120_000;

export const ControlPingInput = Schema.Struct({
  nonce: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(256)))),
});
export type ControlPingInput = typeof ControlPingInput.Type;

export const ControlPingResult = Schema.Struct({
  ok: Schema.Literal(true),
  serverTime: IsoDateTime,
  nonce: Schema.optionalKey(Schema.String),
});
export type ControlPingResult = typeof ControlPingResult.Type;

export const ControlRequestStatusInput = Schema.Struct({});
export type ControlRequestStatusInput = typeof ControlRequestStatusInput.Type;

export const ControlRequestStatusResult = Schema.Struct({
  serverTime: IsoDateTime,
  environmentId: EnvironmentId,
  runtimeMode: Schema.Literals(["web", "desktop"]),
  session: Schema.Struct({
    sessionId: AuthSessionId,
    subject: TrimmedNonEmptyString,
  }),
  onlineClients: NonNegativeInt,
  projects: NonNegativeInt,
  threads: NonNegativeInt,
});
export type ControlRequestStatusResult = typeof ControlRequestStatusResult.Type;

export const ControlSendTextInput = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isPattern(/\S/)),
    Schema.check(Schema.isMaxLength(CONTROL_SEND_TEXT_MAX_CHARS)),
  ),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
});
export type ControlSendTextInput = typeof ControlSendTextInput.Type;

export const ControlSendTextResult = Schema.Struct({
  accepted: Schema.Literal(true),
  commandId: CommandId,
  threadId: ThreadId,
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type ControlSendTextResult = typeof ControlSendTextResult.Type;

export class ControlStatusError extends Schema.TaggedErrorClass<ControlStatusError>()(
  "ControlStatusError",
  { message: TrimmedNonEmptyString },
) {}

export const ControlReadError = Schema.Union([ControlStatusError, EnvironmentAuthorizationError]);

export const ControlSendTextError = Schema.Union([
  OrchestrationDispatchCommandError,
  EnvironmentAuthorizationError,
]);
