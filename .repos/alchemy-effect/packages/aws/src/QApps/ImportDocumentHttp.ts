import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { ImportDocument } from "./ImportDocument.ts";

export const ImportDocumentHttp = Layer.effect(
  ImportDocument,
  makeQAppHttpBinding({
    capability: "ImportDocument",
    iamActions: ["qapps:ImportDocument"],
    operation: qapps.importDocument,
    injectAppId: true,
  }),
);
