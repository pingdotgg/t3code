import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import {
  IMPORT_TASK_ARN_WILDCARD,
  makeNeptuneGraphGraphHttpBinding,
} from "./BindingHttp.ts";
import { StartImportTask } from "./StartImportTask.ts";

export const StartImportTaskHttp = Layer.effect(
  StartImportTask,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.StartImportTask",
    operation: neptunegraph.startImportTask,
    actions: ["neptune-graph:StartImportTask"],
    // StartImportTask authorizes against both the graph and the (not yet
    // existing) import-task resource types.
    extraResources: [IMPORT_TASK_ARN_WILDCARD],
    passRole: true,
  }),
);
