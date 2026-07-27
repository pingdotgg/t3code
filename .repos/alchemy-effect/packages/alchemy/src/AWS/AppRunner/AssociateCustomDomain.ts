import type * as apprunner from "@distilled.cloud/aws/apprunner";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface AssociateCustomDomainRequest extends Omit<
  apprunner.AssociateCustomDomainRequest,
  "ServiceArn"
> {}

/**
 * Associate a custom domain with an App Runner {@link Service} from a
 * Lambda (or other AWS runtime) — the multi-tenant SaaS "bring your own
 * domain" flow: a customer adds their domain, the platform associates it at
 * runtime and hands back the DNS validation records App Runner returns.
 * Track validation with {@link DescribeCustomDomains}.
 *
 * Provide `AppRunner.AssociateCustomDomainHttp` on the hosting function's
 * Effect to implement the binding.
 *
 * @binding
 * @section Custom Domains
 * @example Associate a customer domain
 * ```typescript
 * const associateCustomDomain = yield* AppRunner.AssociateCustomDomain(service);
 * const { CustomDomain, DNSTarget } = yield* associateCustomDomain({
 *   DomainName: "app.customer.com",
 *   EnableWWWSubdomain: false,
 * });
 * // CustomDomain.CertificateValidationRecords -> CNAMEs the customer creates
 * // DNSTarget -> where the customer points app.customer.com
 * ```
 */
export interface AssociateCustomDomain extends Binding.Service<
  AssociateCustomDomain,
  "AWS.AppRunner.AssociateCustomDomain",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: AssociateCustomDomainRequest,
    ) => Effect.Effect<
      apprunner.AssociateCustomDomainResponse,
      apprunner.AssociateCustomDomainError
    >
  >
> {}
export const AssociateCustomDomain = Binding.Service<AssociateCustomDomain>(
  "AWS.AppRunner.AssociateCustomDomain",
);
