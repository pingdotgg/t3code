import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { CancelServiceSoftwareUpdate } from "./CancelServiceSoftwareUpdate.ts";

export const CancelServiceSoftwareUpdateHttp = Layer.effect(
  CancelServiceSoftwareUpdate,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.CancelServiceSoftwareUpdate",
    operation: opensearch.cancelServiceSoftwareUpdate,
    actions: ["es:CancelServiceSoftwareUpdate"],
  }),
);
