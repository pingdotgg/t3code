import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxConnectionString } from "./GetKxConnectionString.ts";

export const GetKxConnectionStringHttp = Layer.effect(
  GetKxConnectionString,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxConnectionString",
    operation: finspace.getKxConnectionString,
    actions: ["finspace:GetKxConnectionString", "finspace:ConnectKxCluster"],
  }),
);
