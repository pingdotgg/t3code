import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { ListJobParameterDefinitions } from "./ListJobParameterDefinitions.ts";

export const ListJobParameterDefinitionsHttp = Layer.effect(
  ListJobParameterDefinitions,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.ListJobParameterDefinitions",
    operation: deadline.listJobParameterDefinitions,
    actions: ["deadline:ListJobParameterDefinitions"],
  }),
);
