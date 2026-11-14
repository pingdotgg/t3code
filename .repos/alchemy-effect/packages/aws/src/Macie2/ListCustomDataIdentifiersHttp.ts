import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { ListCustomDataIdentifiers } from "./ListCustomDataIdentifiers.ts";

export const ListCustomDataIdentifiersHttp = Layer.effect(
  ListCustomDataIdentifiers,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListCustomDataIdentifiers",
    operation: macie2.listCustomDataIdentifiers,
    actions: ["macie2:ListCustomDataIdentifiers"],
  }),
);
