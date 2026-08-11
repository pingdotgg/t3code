import type { GitHubWorkflow } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

const WorkflowScalar = Schema.Union([Schema.String, Schema.Boolean, Schema.Number]);
const WorkflowInput = Schema.Struct({
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.Literals(["boolean", "choice", "number", "environment", "string"])),
  default: Schema.optional(WorkflowScalar),
  options: Schema.optional(Schema.Array(WorkflowScalar)),
});
const WorkflowDispatch = Schema.NullOr(
  Schema.Struct({
    inputs: Schema.optional(Schema.Record(Schema.String, WorkflowInput)),
  }),
);
const WorkflowDocument = Schema.Struct({
  name: Schema.optional(Schema.String),
  on: Schema.Union([
    Schema.Literal("workflow_dispatch"),
    Schema.Array(Schema.String),
    Schema.Struct({ workflow_dispatch: WorkflowDispatch }),
  ]),
});
const decodeWorkflowDocument = Schema.decodeUnknownOption(WorkflowDocument);

export function parseDispatchWorkflow(contents: string, filename: string): GitHubWorkflow | null {
  let workflow: typeof WorkflowDocument.Type | null;
  try {
    workflow = Option.getOrNull(decodeWorkflowDocument(parse(contents)));
  } catch {
    return null;
  }
  if (!workflow) return null;

  const dispatch =
    workflow.on === "workflow_dispatch"
      ? null
      : "workflow_dispatch" in workflow.on
        ? workflow.on.workflow_dispatch
        : workflow.on.includes("workflow_dispatch")
          ? null
          : undefined;
  if (dispatch === undefined) return null;

  const inputs = Object.entries(dispatch?.inputs ?? {}).flatMap(([name, input]) => {
    if (!name.trim()) return [];
    const options = input.options?.map(String);
    return [
      {
        name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        required: input.required === true,
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.default !== undefined ? { defaultValue: String(input.default) } : {}),
        ...(options && options.length > 0 ? { options } : {}),
      },
    ];
  });

  return {
    filename,
    name: workflow.name?.trim() || filename,
    inputs,
  };
}
