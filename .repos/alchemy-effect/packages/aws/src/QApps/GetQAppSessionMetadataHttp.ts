import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { GetQAppSessionMetadata } from "./GetQAppSessionMetadata.ts";

export const GetQAppSessionMetadataHttp = Layer.effect(
  GetQAppSessionMetadata,
  makeQAppHttpBinding({
    capability: "GetQAppSessionMetadata",
    iamActions: ["qapps:GetQAppSessionMetadata"],
    operation: qapps.getQAppSessionMetadata,
  }),
);
