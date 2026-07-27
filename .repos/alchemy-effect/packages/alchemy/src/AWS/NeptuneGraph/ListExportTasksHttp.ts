import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import {
  EXPORT_TASK_ARN_WILDCARD,
  makeNeptuneGraphGraphHttpBinding,
} from "./BindingHttp.ts";
import { ListExportTasks } from "./ListExportTasks.ts";

export const ListExportTasksHttp = Layer.effect(
  ListExportTasks,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.ListExportTasks",
    operation: neptunegraph.listExportTasks,
    actions: ["neptune-graph:ListExportTasks"],
    // ListExportTasks authorizes against the export-task resource type.
    extraResources: [EXPORT_TASK_ARN_WILDCARD],
  }),
);
