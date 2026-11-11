import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractHttpBinding } from "./BindingHttp.ts";
import { ListAdapters } from "./ListAdapters.ts";

export const ListAdaptersHttp = Layer.effect(
  ListAdapters,
  makeTextractHttpBinding({
    capability: "ListAdapters",
    // No resource-level IAM for this action.
    iamActions: ["textract:ListAdapters"],
    operation: textract.listAdapters,
  }),
);
