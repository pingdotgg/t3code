import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractAdapterHttpBinding } from "./BindingHttp.ts";
import { DeleteAdapterVersion } from "./DeleteAdapterVersion.ts";

export const DeleteAdapterVersionHttp = Layer.effect(
  DeleteAdapterVersion,
  makeTextractAdapterHttpBinding({
    capability: "DeleteAdapterVersion",
    iamActions: ["textract:DeleteAdapterVersion"],
    operation: textract.deleteAdapterVersion,
  }),
);
