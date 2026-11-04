import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Layer from "effect/Layer";
import { makeQueryTableHttpBinding } from "./BindingHttp.ts";
import { PrepareQuery } from "./PrepareQuery.ts";

export const PrepareQueryHttp = Layer.effect(
  PrepareQuery,
  makeQueryTableHttpBinding({
    tag: "AWS.Timestream.PrepareQuery",
    operation: TSQ.prepareQuery,
    // Preparing a query validates it against the tables the SQL references.
    actions: ["timestream:PrepareQuery", "timestream:Select"],
  }),
);
