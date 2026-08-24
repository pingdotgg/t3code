import * as apprunner from "@distilled.cloud/aws/apprunner";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import { DescribeCustomDomains } from "./DescribeCustomDomains.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of the {@link DescribeCustomDomains} binding. Calls
 * `apprunner:DescribeCustomDomains` with the Lambda's IAM role, scoped to
 * the bound service.
 */
export const DescribeCustomDomainsHttp = makeAppRunnerHttpBinding(
  DescribeCustomDomains,
  {
    operation: apprunner.describeCustomDomains,
    spec: (service: Service) => ({
      identifiers: { ServiceArn: service.serviceArn },
      iam: () => ({
        actions: ["apprunner:DescribeCustomDomains"],
        resources: [service.serviceArn],
      }),
    }),
  },
);
