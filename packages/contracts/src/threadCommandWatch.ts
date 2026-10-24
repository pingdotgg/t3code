import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const THREAD_COMMAND_WATCH_MAX_COMMAND_LENGTH = 4_000;
const THREAD_COMMAND_WATCH_MAX_LABEL_LENGTH = 120;
const THREAD_COMMAND_WATCH_MAX_EVERY_MINUTES = 24 * 60;
/** Every watch id starts with this, so a watch id never collides with a provider task id. */
export const THREAD_COMMAND_WATCH_ID_PREFIX = "command-watch:";
/** Watches one thread may hold at once. */
export const THREAD_COMMAND_WATCH_LIMIT = 5;

export const ThreadCommandWatchCommand = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_COMMAND_WATCH_MAX_COMMAND_LENGTH),
);
export const ThreadCommandWatchLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_COMMAND_WATCH_MAX_LABEL_LENGTH),
);
export const ThreadCommandWatchEveryMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: THREAD_COMMAND_WATCH_MAX_EVERY_MINUTES }),
);

/**
 * A shell command the server runs on an interval for a thread's agent (`watch_command`). Output
 * that differs from what the agent was last told wakes it. The first run only sets the
 * baseline. Only starts, baselines, wakes and ends are recorded here. Quiet runs write nothing.
 */
export const ThreadCommandWatch = Schema.Struct({
  id: TrimmedNonEmptyString,
  command: ThreadCommandWatchCommand,
  label: ThreadCommandWatchLabel,
  everyMinutes: ThreadCommandWatchEveryMinutes,
  startedAt: IsoDateTime,
  /** SHA-256 of the trimmed output the agent last knew of, null until the baseline run. */
  lastOutputHash: Schema.NullOr(TrimmedNonEmptyString),
  /** Wakes so far. Watching stops at a limit, so output that changes every run cannot loop it. */
  wakes: NonNegativeInt,
});
export type ThreadCommandWatch = typeof ThreadCommandWatch.Type;
