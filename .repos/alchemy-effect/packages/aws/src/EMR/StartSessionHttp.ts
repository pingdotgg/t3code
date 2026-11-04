import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { StartSession } from "./StartSession.ts";

export const StartSessionHttp = Layer.effect(
  StartSession,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.StartSession",
    operation: emr.startSession,
    actions: ["elasticmapreduce:StartSession"],
  }),
);
