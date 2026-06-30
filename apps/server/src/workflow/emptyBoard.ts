import { WorkflowDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeWorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinition);

export const emptyBoardDefinition = (input: { name: string }): WorkflowDefinition =>
  decodeWorkflowDefinition({
    name: input.name,
    lanes: [
      {
        key: "to-do",
        name: "To do",
        entry: "manual",
        actions: [{ label: "Start", to: "in-progress" }],
      },
      {
        key: "in-progress",
        name: "In progress",
        entry: "manual",
        actions: [{ label: "Mark done", to: "done" }],
      },
      { key: "done", name: "Done", entry: "manual", terminal: true },
    ],
  });
