import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { BatchDeleteCategory } from "./BatchDeleteCategory.ts";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteCategoryHttp = Layer.effect(
  BatchDeleteCategory,
  makeQAppsInstanceHttpBinding({
    capability: "BatchDeleteCategory",
    iamActions: ["qapps:BatchDeleteCategory"],
    operation: qapps.batchDeleteCategory,
  }),
);
