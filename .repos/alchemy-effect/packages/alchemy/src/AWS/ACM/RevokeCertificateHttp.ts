import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmCertificateHttpBinding } from "./BindingHttp.ts";
import {
  RevokeCertificate,
  type RevokeCertificateRequest,
} from "./RevokeCertificate.ts";

export const RevokeCertificateHttp = Layer.effect(
  RevokeCertificate,
  makeAcmCertificateHttpBinding({
    capability: "RevokeCertificate",
    iamActions: ["acm:RevokeCertificate"],
    operation: acm.revokeCertificate,
  }),
);
