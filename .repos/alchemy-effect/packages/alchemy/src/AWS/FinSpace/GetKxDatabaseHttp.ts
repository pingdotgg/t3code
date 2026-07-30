import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxDatabase } from "./GetKxDatabase.ts";

export const GetKxDatabaseHttp = Layer.effect(
  GetKxDatabase,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxDatabase",
    operation: finspace.getKxDatabase,
    actions: ["finspace:GetKxDatabase"],
  }),
);
