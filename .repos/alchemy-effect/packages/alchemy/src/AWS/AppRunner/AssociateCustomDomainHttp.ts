import * as apprunner from "@distilled.cloud/aws/apprunner";
import { AssociateCustomDomain } from "./AssociateCustomDomain.ts";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of the {@link AssociateCustomDomain} binding. Calls
 * `apprunner:AssociateCustomDomain` with the Lambda's IAM role, scoped to
 * the bound service.
 */
export const AssociateCustomDomainHttp = makeAppRunnerHttpBinding(
  AssociateCustomDomain,
  {
    operation: apprunner.associateCustomDomain,
    spec: (service: Service) => ({
      identifiers: { ServiceArn: service.serviceArn },
      iam: () => ({
        actions: ["apprunner:AssociateCustomDomain"],
        resources: [service.serviceArn],
      }),
    }),
  },
);
