import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { ListResourceEvaluations } from "./ListResourceEvaluations.ts";

export const ListResourceEvaluationsHttp = Layer.effect(
  ListResourceEvaluations,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.ListResourceEvaluations",
    operation: config.listResourceEvaluations,
    actions: ["config:ListResourceEvaluations"],
  }),
);
