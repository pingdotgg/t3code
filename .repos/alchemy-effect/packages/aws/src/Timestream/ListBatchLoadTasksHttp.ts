import * as TSW from "@distilled.cloud/aws/timestream-write";
import * as Layer from "effect/Layer";
import { makeWriteAccountHttpBinding } from "./BindingHttp.ts";
import { ListBatchLoadTasks } from "./ListBatchLoadTasks.ts";

export const ListBatchLoadTasksHttp = Layer.effect(
  ListBatchLoadTasks,
  makeWriteAccountHttpBinding({
    tag: "AWS.Timestream.ListBatchLoadTasks",
    operation: TSW.listBatchLoadTasks,
    actions: ["timestream:ListBatchLoadTasks"],
  }),
);
