import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Layer from "effect/Layer";
import { makeQueryTableHttpBinding } from "./BindingHttp.ts";
import { Query } from "./Query.ts";

export const QueryHttp = Layer.effect(
  Query,
  makeQueryTableHttpBinding({
    tag: "AWS.Timestream.Query",
    operation: TSQ.query,
    actions: ["timestream:Select"],
  }),
);
