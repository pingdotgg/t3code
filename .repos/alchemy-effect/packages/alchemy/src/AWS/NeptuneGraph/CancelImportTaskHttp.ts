import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import {
  IMPORT_TASK_ARN_WILDCARD,
  makeNeptuneGraphAccountHttpBinding,
} from "./BindingHttp.ts";
import { CancelImportTask } from "./CancelImportTask.ts";

export const CancelImportTaskHttp = Layer.effect(
  CancelImportTask,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.CancelImportTask",
    operation: neptunegraph.cancelImportTask,
    actions: ["neptune-graph:CancelImportTask"],
    resources: [IMPORT_TASK_ARN_WILDCARD],
  }),
);
