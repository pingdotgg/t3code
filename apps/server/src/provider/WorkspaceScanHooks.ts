import * as Context from "effect/Context";

/**
 * A workspace scan may start a provider session in any cwd the caller names,
 * and session hooks run the user's or the project's code there. A read-only
 * caller still gets the inventory a hook-free scan finds; only callers that
 * may operate the environment set this.
 */
export const WorkspaceScanRunsHooks = Context.Reference<boolean>(
  "t3/provider/WorkspaceScanRunsHooks",
  { defaultValue: () => false },
);
