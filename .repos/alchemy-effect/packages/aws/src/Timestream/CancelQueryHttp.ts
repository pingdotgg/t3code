import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Layer from "effect/Layer";
import { makeQueryAccountHttpBinding } from "./BindingHttp.ts";
import { CancelQuery } from "./CancelQuery.ts";

export const CancelQueryHttp = Layer.effect(
  CancelQuery,
  makeQueryAccountHttpBinding({
    tag: "AWS.Timestream.CancelQuery",
    operation: TSQ.cancelQuery,
    actions: ["timestream:CancelQuery"],
  }),
);
