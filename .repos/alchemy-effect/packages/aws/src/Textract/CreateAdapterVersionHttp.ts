import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractAdapterHttpBinding } from "./BindingHttp.ts";
import { CreateAdapterVersion } from "./CreateAdapterVersion.ts";

export const CreateAdapterVersionHttp = Layer.effect(
  CreateAdapterVersion,
  makeTextractAdapterHttpBinding({
    capability: "CreateAdapterVersion",
    iamActions: ["textract:CreateAdapterVersion"],
    operation: textract.createAdapterVersion,
  }),
);
