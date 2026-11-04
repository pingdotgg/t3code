import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { BatchCreateCategory } from "./BatchCreateCategory.ts";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";

export const BatchCreateCategoryHttp = Layer.effect(
  BatchCreateCategory,
  makeQAppsInstanceHttpBinding({
    capability: "BatchCreateCategory",
    iamActions: ["qapps:BatchCreateCategory"],
    operation: qapps.batchCreateCategory,
  }),
);
