import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { GetResourceLFTags } from "./GetResourceLFTags.ts";

export const GetResourceLFTagsHttp = Layer.effect(
  GetResourceLFTags,
  makeLakeFormationHttpBinding({
    capability: "GetResourceLFTags",
    iamActions: ["lakeformation:GetResourceLFTags"],
    operation: lf.getResourceLFTags,
  }),
);
