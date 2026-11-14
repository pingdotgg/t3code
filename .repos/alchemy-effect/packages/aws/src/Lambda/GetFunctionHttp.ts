import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { GetFunction } from "./GetFunction.ts";

export const GetFunctionHttp = Layer.effect(
  GetFunction,
  makeFunctionHttpBinding({
    tag: "AWS.Lambda.GetFunction",
    operation: Lambda.getFunction,
    actions: ["lambda:GetFunction"],
  }),
);
