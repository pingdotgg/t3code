import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeSfnServiceHttpBinding } from "./BindingHttp.ts";
import { TestState } from "./TestState.ts";

export const TestStateHttp = Layer.effect(
  TestState,
  makeSfnServiceHttpBinding({
    tag: "AWS.StepFunctions.TestState",
    actions: ["states:TestState"],
    operation: sfn.testState,
  }),
);
