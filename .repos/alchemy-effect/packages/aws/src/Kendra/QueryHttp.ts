import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { Query } from "./Query.ts";

export const QueryHttp = Layer.effect(
  Query,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.Query",
    operation: kendra.query,
    actions: ["kendra:Query"],
  }),
);
