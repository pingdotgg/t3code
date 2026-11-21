import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Home is the Bot (see `bots.ts`) whose scope is the whole environment: every project here and in
 * linked environments. Its ids carry this prefix so any client can label Home without reading settings.
 */
export const HOME_THREAD_ID_PREFIX = "home:";

export const isHomeThreadId = (threadId: string): boolean =>
  threadId.startsWith(HOME_THREAD_ID_PREFIX);

/**
 * Stored on `ServerSettings.home`. Clients read it with settings but cannot patch it: only the
 * Home RPCs write it.
 */
export const HomeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Null uses the environment's default model. */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HomeSettings = typeof HomeSettings.Type;

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  enabled: false,
  threadId: null,
  modelSelection: null,
};

export const HomeEnableInput = Schema.Struct({
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type HomeEnableInput = typeof HomeEnableInput.Type;

export const HomeSetModelInput = Schema.Struct({ modelSelection: ModelSelection });
export type HomeSetModelInput = typeof HomeSetModelInput.Type;

export const HomeThreadResult = Schema.Struct({ threadId: ThreadId });
export type HomeThreadResult = typeof HomeThreadResult.Type;

export const HomeErrorReason = Schema.Literals([
  "off",
  "no-model",
  "launch-failed",
  "settings-unavailable",
]);
export type HomeErrorReason = typeof HomeErrorReason.Type;

const HOME_ERROR_MESSAGES: Record<HomeErrorReason, string> = {
  off: "Home is off. Turn it on first.",
  "no-model": "Choose a model for Home first.",
  "launch-failed": "Home's thread could not be started.",
  "settings-unavailable": "Home's settings could not be read or saved.",
};

export class HomeError extends Schema.TaggedError<HomeError>()("HomeError", {
  reason: HomeErrorReason,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return HOME_ERROR_MESSAGES[this.reason];
  }
}
