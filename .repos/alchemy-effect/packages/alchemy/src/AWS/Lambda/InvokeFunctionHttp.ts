import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { InvokeFunction } from "./InvokeFunction.ts";

export const InvokeFunctionHttp = Layer.effect(
  InvokeFunction,
  makeFunctionHttpBinding({
    tag: "AWS.Lambda.InvokeFunction",
    operation: Lambda.invoke,
    actions: ["lambda:InvokeFunction"],
  }),
);
