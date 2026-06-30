import { createWorkflowEnvironmentAtoms } from "@t3tools/client-runtime/state/workflow";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Web binding for the workflow-board environment atoms. Components read board
 * state via `useEnvironmentQuery(workflowEnvironment.board({ environmentId,
 * input: { boardId } }))` / the query families, and mutate via
 * `useAtomCommand(workflowEnvironment.<command>)`. Replaces the deleted
 * `readEnvironmentApi(env).workflow.*` facade.
 */
export const workflowEnvironment = createWorkflowEnvironmentAtoms(connectionAtomRuntime);
