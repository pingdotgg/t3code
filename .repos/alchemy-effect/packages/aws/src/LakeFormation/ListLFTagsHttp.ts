import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { ListLFTags } from "./ListLFTags.ts";

export const ListLFTagsHttp = Layer.effect(
  ListLFTags,
  makeLakeFormationHttpBinding({
    capability: "ListLFTags",
    iamActions: ["lakeformation:ListLFTags"],
    operation: lf.listLFTags,
  }),
);
