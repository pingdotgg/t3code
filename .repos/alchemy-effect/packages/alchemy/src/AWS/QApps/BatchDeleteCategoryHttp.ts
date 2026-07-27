import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { BatchDeleteCategory } from "./BatchDeleteCategory.ts";

export const BatchDeleteCategoryHttp = Layer.effect(
  BatchDeleteCategory,
  makeQAppsInstanceHttpBinding({
    capability: "BatchDeleteCategory",
    iamActions: ["qapps:BatchDeleteCategory"],
    operation: qapps.batchDeleteCategory,
  }),
);
