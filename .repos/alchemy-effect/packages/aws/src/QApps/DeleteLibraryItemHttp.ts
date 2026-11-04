import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteLibraryItem } from "./DeleteLibraryItem.ts";

export const DeleteLibraryItemHttp = Layer.effect(
  DeleteLibraryItem,
  makeQAppsInstanceHttpBinding({
    capability: "DeleteLibraryItem",
    iamActions: ["qapps:DeleteLibraryItem"],
    operation: qapps.deleteLibraryItem,
  }),
);
