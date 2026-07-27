import * as apprunner from "@distilled.cloud/aws/apprunner";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import { DisassociateCustomDomain } from "./DisassociateCustomDomain.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of the {@link DisassociateCustomDomain} binding.
 * Calls `apprunner:DisassociateCustomDomain` with the Lambda's IAM role,
 * scoped to the bound service.
 */
export const DisassociateCustomDomainHttp = makeAppRunnerHttpBinding(
  DisassociateCustomDomain,
  {
    operation: apprunner.disassociateCustomDomain,
    spec: (service: Service) => ({
      identifiers: { ServiceArn: service.serviceArn },
      iam: () => ({
        actions: ["apprunner:DisassociateCustomDomain"],
        resources: [service.serviceArn],
      }),
    }),
  },
);
