import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import {
  IMPORT_TASK_ARN_WILDCARD,
  makeNeptuneGraphAccountHttpBinding,
} from "./BindingHttp.ts";
import { GetImportTask } from "./GetImportTask.ts";

export const GetImportTaskHttp = Layer.effect(
  GetImportTask,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.GetImportTask",
    operation: neptunegraph.getImportTask,
    actions: ["neptune-graph:GetImportTask"],
    resources: [IMPORT_TASK_ARN_WILDCARD],
  }),
);
