import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Layer from "effect/Layer";
import { makeTrustStoreHttpBinding } from "./BindingHttp.ts";
import { GetTrustStoreCaCertificatesBundle } from "./GetTrustStoreCaCertificatesBundle.ts";

export const GetTrustStoreCaCertificatesBundleHttp = Layer.effect(
  GetTrustStoreCaCertificatesBundle,
  makeTrustStoreHttpBinding({
    tag: "AWS.ELBv2.GetTrustStoreCaCertificatesBundle",
    operation: elbv2.getTrustStoreCaCertificatesBundle,
    actions: ["elasticloadbalancing:GetTrustStoreCaCertificatesBundle"],
  }),
);
