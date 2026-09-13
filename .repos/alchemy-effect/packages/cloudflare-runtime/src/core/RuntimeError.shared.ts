import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * `ConfigError` indicates a problem with the user's worker config or script.
 * The user can typically fix the problem by changing their input.
 *
 * Examples: an unsupported binding type, a missing hyperdrive origin, a
 * syntax error in the user's script.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    subtag: Schema.String,
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * `SystemError` indicates a problem with the user's environment, the local
 * machine, or a process this package depends on (workerd, cloudflared,
 * filesystem, network sockets). The user may be able to fix the problem,
 * but it is not a bug in their worker.
 */
export class SystemError extends Schema.TaggedError<SystemError>()(
  "SystemError",
  {
    subtag: Schema.String,
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * `ApiError` indicates a problem returned from the Cloudflare API or its
 * SDK (e.g. preview-session creation failed, script preview upload was
 * rejected, the SDK considered the request invalid). Often transient or an
 * authentication / permissions issue; can also be a bug in this package's
 * usage of the API.
 */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  subtag: Schema.String,
  message: Schema.String,
  hint: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * Top-level union of every error users can observe through `Server.serve()`
 * or while accessing remote bindings at runtime.
 *
 * Defects (raised via `Effect.die`) are intentionally not part of this
 * union: they indicate a bug inside this package, not something the user
 * is expected to handle.
 */
export const RuntimeError = Schema.Union([ConfigError, SystemError, ApiError]);
export type RuntimeError = ConfigError | SystemError | ApiError;

export const isRuntimeError = (error: unknown): error is RuntimeError =>
  Predicate.isTagged(error, "ConfigError") ||
  Predicate.isTagged(error, "SystemError") ||
  Predicate.isTagged(error, "ApiError");
