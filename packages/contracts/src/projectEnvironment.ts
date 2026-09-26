import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * `direnv allow` the `.envrc` governing a thread's workspace. The server
 * resolves the directory from the thread, so a client cannot name an
 * arbitrary path. The next message picks the environment up.
 */
export const ProjectEnvironmentAllowDirenvInput = Schema.Struct({ threadId: ThreadId });
export type ProjectEnvironmentAllowDirenvInput = typeof ProjectEnvironmentAllowDirenvInput.Type;

export const ProjectEnvironmentAllowDirenvResult = Schema.Struct({
  allowed: Schema.Boolean,
  /** Why nothing was allowed. */
  error: Schema.optional(Schema.String),
});
export type ProjectEnvironmentAllowDirenvResult = typeof ProjectEnvironmentAllowDirenvResult.Type;
