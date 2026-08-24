import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import {
  EXPORT_TASK_ARN_WILDCARD,
  makeNeptuneGraphGraphHttpBinding,
} from "./BindingHttp.ts";
import { StartExportTask } from "./StartExportTask.ts";

export const StartExportTaskHttp = Layer.effect(
  StartExportTask,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.StartExportTask",
    operation: neptunegraph.startExportTask,
    actions: ["neptune-graph:StartExportTask"],
    // StartExportTask authorizes against both the graph and the (not yet
    // existing) export-task resource types.
    extraResources: [EXPORT_TASK_ARN_WILDCARD],
    passRole: true,
  }),
);
