import * as textract from "@distilled.cloud/aws/textract";
import * as Layer from "effect/Layer";
import { makeTextractAdapterHttpBinding } from "./BindingHttp.ts";
import { GetAdapterVersion } from "./GetAdapterVersion.ts";

export const GetAdapterVersionHttp = Layer.effect(
  GetAdapterVersion,
  makeTextractAdapterHttpBinding({
    capability: "GetAdapterVersion",
    iamActions: ["textract:GetAdapterVersion"],
    operation: textract.getAdapterVersion,
  }),
);
