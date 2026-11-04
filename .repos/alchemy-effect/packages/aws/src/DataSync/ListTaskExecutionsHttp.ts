import * as datasync from "@distilled.cloud/aws/datasync";
import * as Layer from "effect/Layer";
import { makeDataSyncTaskHttpBinding } from "./BindingHttp.ts";
import { ListTaskExecutions } from "./ListTaskExecutions.ts";

export const ListTaskExecutionsHttp = Layer.effect(
  ListTaskExecutions,
  makeDataSyncTaskHttpBinding({
    tag: "AWS.DataSync.ListTaskExecutions",
    operation: datasync.listTaskExecutions,
    actions: ["datasync:ListTaskExecutions"],
  }),
);
