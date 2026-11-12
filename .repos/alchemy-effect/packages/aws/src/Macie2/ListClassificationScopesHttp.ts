import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { ListClassificationScopes } from "./ListClassificationScopes.ts";

export const ListClassificationScopesHttp = Layer.effect(
  ListClassificationScopes,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListClassificationScopes",
    operation: macie2.listClassificationScopes,
    actions: ["macie2:ListClassificationScopes"],
  }),
);
