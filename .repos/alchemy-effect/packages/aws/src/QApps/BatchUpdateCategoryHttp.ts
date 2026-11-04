import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { BatchUpdateCategory } from "./BatchUpdateCategory.ts";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";

export const BatchUpdateCategoryHttp = Layer.effect(
  BatchUpdateCategory,
  makeQAppsInstanceHttpBinding({
    capability: "BatchUpdateCategory",
    iamActions: ["qapps:BatchUpdateCategory"],
    operation: qapps.batchUpdateCategory,
  }),
);
