import type * as apprunner from "@distilled.cloud/aws/apprunner";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface DisassociateCustomDomainRequest extends Omit<
  apprunner.DisassociateCustomDomainRequest,
  "ServiceArn"
> {}

/**
 * Disassociate a custom domain from an App Runner {@link Service} from a
 * Lambda (or other AWS runtime) — the teardown half of the multi-tenant
 * SaaS domain flow when a customer removes their domain.
 *
 * Provide `AppRunner.DisassociateCustomDomainHttp` on the hosting
 * function's Effect to implement the binding.
 *
 * @binding
 * @section Custom Domains
 * @example Remove a customer domain
 * ```typescript
 * const disassociateCustomDomain =
 *   yield* AppRunner.DisassociateCustomDomain(service);
 * yield* disassociateCustomDomain({ DomainName: "app.customer.com" });
 * ```
 */
export interface DisassociateCustomDomain extends Binding.Service<
  DisassociateCustomDomain,
  "AWS.AppRunner.DisassociateCustomDomain",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: DisassociateCustomDomainRequest,
    ) => Effect.Effect<
      apprunner.DisassociateCustomDomainResponse,
      apprunner.DisassociateCustomDomainError
    >
  >
> {}
export const DisassociateCustomDomain =
  Binding.Service<DisassociateCustomDomain>(
    "AWS.AppRunner.DisassociateCustomDomain",
  );
