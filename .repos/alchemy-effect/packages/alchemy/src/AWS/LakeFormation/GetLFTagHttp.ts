import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { GetLFTag } from "./GetLFTag.ts";

export const GetLFTagHttp = Layer.effect(
  GetLFTag,
  makeLakeFormationHttpBinding({
    capability: "GetLFTag",
    iamActions: ["lakeformation:GetLFTag"],
    operation: lf.getLFTag,
  }),
);
