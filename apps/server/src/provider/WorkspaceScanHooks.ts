import * as Context from "effect/Context";

/**
 * A workspace scan that runs session hooks executes the user's or the project's code in a cwd the
 * caller names, so only callers that may operate the environment set this.
 */
export const WorkspaceScanRunsHooks = Context.Reference<boolean>(
  "t3/provider/WorkspaceScanRunsHooks",
  { defaultValue: () => false },
);
