import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateLibraryItemMetadata } from "./UpdateLibraryItemMetadata.ts";

export const UpdateLibraryItemMetadataHttp = Layer.effect(
  UpdateLibraryItemMetadata,
  makeQAppsInstanceHttpBinding({
    capability: "UpdateLibraryItemMetadata",
    iamActions: ["qapps:UpdateLibraryItemMetadata"],
    operation: qapps.updateLibraryItemMetadata,
  }),
);
