import type * as apprunner from "@distilled.cloud/aws/apprunner";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface DescribeCustomDomainsRequest extends Omit<
  apprunner.DescribeCustomDomainsRequest,
  "ServiceArn"
> {}

/**
 * Describe the custom domains associated with an App Runner
 * {@link Service} from a Lambda (or other AWS runtime) — poll a domain's
 * certificate validation status (`PENDING_VALIDATION` -> `SUCCESS`) after
 * {@link AssociateCustomDomain}, and read the `DNSTarget` customers point
 * their DNS at.
 *
 * Provide `AppRunner.DescribeCustomDomainsHttp` on the hosting function's
 * Effect to implement the binding.
 *
 * @binding
 * @section Custom Domains
 * @example Check a domain's validation status
 * ```typescript
 * const describeCustomDomains = yield* AppRunner.DescribeCustomDomains(service);
 * const { CustomDomains, DNSTarget } = yield* describeCustomDomains();
 * const domain = CustomDomains.find((d) => d.DomainName === "app.customer.com");
 * // domain?.Status -> "pending_certificate_dns_validation" | "active" | ...
 * ```
 */
export interface DescribeCustomDomains extends Binding.Service<
  DescribeCustomDomains,
  "AWS.AppRunner.DescribeCustomDomains",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: DescribeCustomDomainsRequest,
    ) => Effect.Effect<
      apprunner.DescribeCustomDomainsResponse,
      apprunner.DescribeCustomDomainsError
    >
  >
> {}
export const DescribeCustomDomains = Binding.Service<DescribeCustomDomains>(
  "AWS.AppRunner.DescribeCustomDomains",
);
