import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmAccountHttpBinding } from "./BindingHttp.ts";
import {
  SearchCertificates,
  type SearchCertificatesRequest,
} from "./SearchCertificates.ts";

export const SearchCertificatesHttp = Layer.effect(
  SearchCertificates,
  makeAcmAccountHttpBinding({
    capability: "SearchCertificates",
    iamActions: ["acm:SearchCertificates"],
    operation: acm.searchCertificates,
  }),
);
