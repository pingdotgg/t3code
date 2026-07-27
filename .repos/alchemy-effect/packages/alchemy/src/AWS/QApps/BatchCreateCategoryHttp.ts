import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { BatchCreateCategory } from "./BatchCreateCategory.ts";

export const BatchCreateCategoryHttp = Layer.effect(
  BatchCreateCategory,
  makeQAppsInstanceHttpBinding({
    capability: "BatchCreateCategory",
    iamActions: ["qapps:BatchCreateCategory"],
    operation: qapps.batchCreateCategory,
  }),
);
