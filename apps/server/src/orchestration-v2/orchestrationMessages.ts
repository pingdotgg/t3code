/**
 * User-facing strings shared by the orchestrator and its extracted handlers.
 *
 * Kept in one module so the dispatcher and the handler modules cannot drift.
 */
export const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";
export const RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE =
  "T3 Code could not confirm that your answer reached the agent. If the run stays stuck, stop it and try again.";
