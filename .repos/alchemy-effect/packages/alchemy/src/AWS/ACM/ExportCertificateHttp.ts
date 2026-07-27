import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmCertificateHttpBinding } from "./BindingHttp.ts";
import {
  ExportCertificate,
  type ExportCertificateRequest,
} from "./ExportCertificate.ts";

export const ExportCertificateHttp = Layer.effect(
  ExportCertificate,
  makeAcmCertificateHttpBinding({
    capability: "ExportCertificate",
    iamActions: ["acm:ExportCertificate"],
    operation: acm.exportCertificate,
  }),
);
