import * as Config from "effect/Config";
import * as Data from "effect/Data";

export class MissingDaytonaApiKeyError extends Data.TaggedError("MissingDaytonaApiKeyError")<{
  readonly message: string;
}> {}

export class DaytonaClientInitializationError extends Data.TaggedError(
  "DaytonaClientInitializationError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type CreateDaytonaClientError =
  | MissingDaytonaApiKeyError
  | DaytonaClientInitializationError
  | Config.ConfigError;
