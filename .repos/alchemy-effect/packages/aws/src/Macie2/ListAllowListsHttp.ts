import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { ListAllowLists } from "./ListAllowLists.ts";

export const ListAllowListsHttp = Layer.effect(
  ListAllowLists,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListAllowLists",
    operation: macie2.listAllowLists,
    actions: ["macie2:ListAllowLists"],
  }),
);
