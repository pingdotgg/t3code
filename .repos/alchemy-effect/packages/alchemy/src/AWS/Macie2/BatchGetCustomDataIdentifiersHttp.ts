import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { BatchGetCustomDataIdentifiers } from "./BatchGetCustomDataIdentifiers.ts";

export const BatchGetCustomDataIdentifiersHttp = Layer.effect(
  BatchGetCustomDataIdentifiers,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.BatchGetCustomDataIdentifiers",
    operation: macie2.batchGetCustomDataIdentifiers,
    actions: ["macie2:BatchGetCustomDataIdentifiers"],
  }),
);
