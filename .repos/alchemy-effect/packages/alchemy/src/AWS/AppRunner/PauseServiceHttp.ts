import * as apprunner from "@distilled.cloud/aws/apprunner";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import { PauseService } from "./PauseService.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of the {@link PauseService} binding. Calls
 * `apprunner:PauseService` with the Lambda's IAM role, scoped to the bound
 * service.
 */
export const PauseServiceHttp = makeAppRunnerHttpBinding(PauseService, {
  operation: apprunner.pauseService,
  spec: (service: Service) => ({
    identifiers: { ServiceArn: service.serviceArn },
    iam: () => ({
      actions: ["apprunner:PauseService"],
      resources: [service.serviceArn],
    }),
  }),
});
