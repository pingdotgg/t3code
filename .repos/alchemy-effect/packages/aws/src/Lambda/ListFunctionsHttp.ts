import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Layer from "effect/Layer";
import { makeLambdaAccountHttpBinding } from "./BindingHttp.ts";
import { ListFunctions } from "./ListFunctions.ts";

export const ListFunctionsHttp = Layer.effect(
  ListFunctions,
  makeLambdaAccountHttpBinding({
    tag: "AWS.Lambda.ListFunctions",
    operation: Lambda.listFunctions,
    actions: ["lambda:ListFunctions"],
  }),
);
