/**
 * BuiltinWorkflows - Registry of built-in workflow definitions.
 *
 * These workflows are shipped with the application and can be executed
 * immediately without user configuration.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";
import { WorkflowDefinition } from "./WorkflowSchema.ts";

const BUILTIN_WORKFLOWS = ["code-review", "parallel-search", "multi-model-eval"] as const;

export type BuiltinWorkflowName = (typeof BUILTIN_WORKFLOWS)[number];

export class BuiltinWorkflowError extends Schema.TaggedErrorClass<BuiltinWorkflowError>()(
  "BuiltinWorkflowError",
  {
    workflowName: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeWorkflowJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowDefinition));

/**
 * Load a built-in workflow by name.
 */
export const loadBuiltinWorkflow = (
  name: BuiltinWorkflowName,
): Effect.Effect<WorkflowDefinition, BuiltinWorkflowError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workflowPath = NodeURL.fileURLToPath(new URL(`./builtins/${name}.json`, import.meta.url));
    const content = yield* fs.readFileString(workflowPath);
    return yield* decodeWorkflowJson(content);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BuiltinWorkflowError({
          workflowName: name,
          cause,
        }),
    ),
  );

/**
 * List all available built-in workflows.
 */
export const listBuiltinWorkflows = (): ReadonlyArray<{
  name: string;
  description: string;
}> => [
  {
    name: "code-review",
    description: "Multi-agent code review with security, performance, and style checks",
  },
  {
    name: "parallel-search",
    description: "Search multiple sources (docs, code, issues, tests) in parallel",
  },
  {
    name: "multi-model-eval",
    description: "Get answers from multiple models and synthesize the best response",
  },
];

/**
 * Check if a workflow name is a built-in.
 */
export const isBuiltinWorkflow = (name: string): name is BuiltinWorkflowName => {
  return (BUILTIN_WORKFLOWS as readonly string[]).includes(name);
};
