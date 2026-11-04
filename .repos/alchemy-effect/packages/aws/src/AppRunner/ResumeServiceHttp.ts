import * as apprunner from "@distilled.cloud/aws/apprunner";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import { ResumeService } from "./ResumeService.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of the {@link ResumeService} binding. Calls
 * `apprunner:ResumeService` with the Lambda's IAM role, scoped to the bound
 * service.
 */
export const ResumeServiceHttp = makeAppRunnerHttpBinding(ResumeService, {
  operation: apprunner.resumeService,
  spec: (service: Service) => ({
    identifiers: { ServiceArn: service.serviceArn },
    iam: () => ({
      actions: ["apprunner:ResumeService"],
      resources: [service.serviceArn],
    }),
  }),
});
