import * as apprunner from "@distilled.cloud/aws/apprunner";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";
import { StartDeployment } from "./StartDeployment.ts";

/**
 * HTTP implementation of the {@link StartDeployment} binding. Calls
 * `apprunner:StartDeployment` with the Lambda's IAM role, scoped to the
 * bound service.
 */
export const StartDeploymentHttp = makeAppRunnerHttpBinding(StartDeployment, {
  operation: apprunner.startDeployment,
  spec: (service: Service) => ({
    identifiers: { ServiceArn: service.serviceArn },
    iam: () => ({
      actions: ["apprunner:StartDeployment"],
      resources: [service.serviceArn],
    }),
  }),
});
