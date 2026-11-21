import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Home is one agent thread per environment that coordinates work across its projects and linked
 * environments. Its ids carry this prefix so any client can label Home without reading settings.
 */
export const HOME_THREAD_ID_PREFIX = "home:";

export const isHomeThreadId = (threadId: string): boolean =>
  threadId.startsWith(HOME_THREAD_ID_PREFIX);

/** `launched`: Home started the thread. `manual`: Home or the user asked to watch it. */
export const HomeWatchReason = Schema.Literals(["launched", "manual"]);
export type HomeWatchReason = typeof HomeWatchReason.Type;

const HomeWatchFields = {
  /** Absent means this environment. */
  environmentId: Schema.optionalKey(EnvironmentId),
  reason: HomeWatchReason,
  addedAt: IsoDateTime,
};

export const HomeThreadWatch = Schema.Struct({ threadId: ThreadId, ...HomeWatchFields });
export const HomeWorkflowRunWatch = Schema.Struct({
  workflowRunId: TrimmedNonEmptyString,
  ...HomeWatchFields,
});

/** A thread or a workflow run whose milestones wake Home until it settles. */
export const HomeWatch = Schema.Union([HomeThreadWatch, HomeWorkflowRunWatch]);
export type HomeWatch = typeof HomeWatch.Type;

export const HomeWatchTarget = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  Schema.Struct({ workflowRunId: TrimmedNonEmptyString }),
]);
export type HomeWatchTarget = typeof HomeWatchTarget.Type;

export const homeWatchKey = (target: HomeWatchTarget): string =>
  "threadId" in target ? `thread:${target.threadId}` : `workflow:${target.workflowRunId}`;

/**
 * Stored on `ServerSettings.home`. Clients read it with settings but cannot patch it: only the
 * Home RPCs and Home's own tools write it.
 */
export const HomeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Null uses the environment's default model. */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  watches: Schema.Array(HomeWatch).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type HomeSettings = typeof HomeSettings.Type;

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  enabled: false,
  threadId: null,
  modelSelection: null,
  watches: [],
};

export const HomeEnableInput = Schema.Struct({
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type HomeEnableInput = typeof HomeEnableInput.Type;

export const HomeSetModelInput = Schema.Struct({ modelSelection: ModelSelection });
export type HomeSetModelInput = typeof HomeSetModelInput.Type;

export const HomeThreadResult = Schema.Struct({ threadId: ThreadId });
export type HomeThreadResult = typeof HomeThreadResult.Type;

/** Home's `notes.md`, which persists across fresh starts. */
export const HomeNotes = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type HomeNotes = typeof HomeNotes.Type;

export const HomeWatchesResult = Schema.Struct({ watches: Schema.Array(HomeWatch) });
export type HomeWatchesResult = typeof HomeWatchesResult.Type;

export const HomeErrorReason = Schema.Literals([
  "off",
  "no-model",
  "launch-failed",
  "settings-unavailable",
  "notes-unavailable",
  "not-home",
]);
export type HomeErrorReason = typeof HomeErrorReason.Type;

const HOME_ERROR_MESSAGES: Record<HomeErrorReason, string> = {
  off: "Home is off. Turn it on first.",
  "no-model": "Choose a model for Home first.",
  "launch-failed": "Home's thread could not be started.",
  "settings-unavailable": "Home's settings could not be read or saved.",
  "notes-unavailable": "Home's notes could not be read or saved.",
  "not-home": "This thread is no longer Home.",
};

export class HomeError extends Schema.TaggedError<HomeError>()("HomeError", {
  reason: HomeErrorReason,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return HOME_ERROR_MESSAGES[this.reason];
  }
}
