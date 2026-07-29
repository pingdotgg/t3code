import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { UpdateQAppSessionMetadata } from "./UpdateQAppSessionMetadata.ts";

export const UpdateQAppSessionMetadataHttp = Layer.effect(
  UpdateQAppSessionMetadata,
  makeQAppHttpBinding({
    capability: "UpdateQAppSessionMetadata",
    iamActions: ["qapps:UpdateQAppSessionMetadata"],
    operation: qapps.updateQAppSessionMetadata,
  }),
);
