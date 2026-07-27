import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { InvokeWithResponseStream } from "./InvokeWithResponseStream.ts";

export const InvokeWithResponseStreamHttp = Layer.effect(
  InvokeWithResponseStream,
  makeFunctionHttpBinding({
    tag: "AWS.Lambda.InvokeWithResponseStream",
    operation: Lambda.invokeWithResponseStream,
    actions: ["lambda:InvokeFunction"],
  }),
);
