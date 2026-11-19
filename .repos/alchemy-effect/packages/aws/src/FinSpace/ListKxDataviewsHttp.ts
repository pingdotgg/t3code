import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { ListKxDataviews } from "./ListKxDataviews.ts";

export const ListKxDataviewsHttp = Layer.effect(
  ListKxDataviews,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxDataviews",
    operation: finspace.listKxDataviews,
    actions: ["finspace:ListKxDataviews"],
  }),
);
