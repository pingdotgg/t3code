import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Function } from "./Function.ts";

export interface InvokeFunctionRequest extends Omit<
  Lambda.InvocationRequest,
  "FunctionName"
> {}

/** @binding */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "AWS.Lambda.InvokeFunction",
  (
    func: Function,
  ) => Effect.Effect<
    (
      request: InvokeFunctionRequest,
    ) => Effect.Effect<Lambda.InvocationResponse, Lambda.InvokeError>
  >
> {}
export const InvokeFunction = Binding.Service<InvokeFunction>(
  "AWS.Lambda.InvokeFunction",
);
