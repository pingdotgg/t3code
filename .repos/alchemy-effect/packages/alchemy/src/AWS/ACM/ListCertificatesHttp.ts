import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmAccountHttpBinding } from "./BindingHttp.ts";
import {
  ListCertificates,
  type ListCertificatesRequest,
} from "./ListCertificates.ts";

export const ListCertificatesHttp = Layer.effect(
  ListCertificates,
  makeAcmAccountHttpBinding({
    capability: "ListCertificates",
    iamActions: ["acm:ListCertificates"],
    operation: acm.listCertificates,
  }),
);
