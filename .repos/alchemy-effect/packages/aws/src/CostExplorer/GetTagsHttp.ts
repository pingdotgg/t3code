import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Layer from "effect/Layer";
import { makeCostExplorerHttpBinding } from "./BindingHttp.ts";
import { GetTags } from "./GetTags.ts";

export const GetTagsHttp = Layer.effect(
  GetTags,
  makeCostExplorerHttpBinding({
    capability: "GetTags",
    iamActions: ["ce:GetTags"],
    operation: ce.getTags,
  }),
);
