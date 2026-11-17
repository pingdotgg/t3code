import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { GetSession } from "./GetSession.ts";

export const GetSessionHttp = Layer.effect(
  GetSession,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.GetSession",
    operation: emr.getSession,
    actions: ["elasticmapreduce:GetSession"],
  }),
);
