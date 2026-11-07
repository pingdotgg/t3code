import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { TestCustomDataIdentifier } from "./TestCustomDataIdentifier.ts";

export const TestCustomDataIdentifierHttp = Layer.effect(
  TestCustomDataIdentifier,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.TestCustomDataIdentifier",
    operation: macie2.testCustomDataIdentifier,
    actions: ["macie2:TestCustomDataIdentifier"],
  }),
);
