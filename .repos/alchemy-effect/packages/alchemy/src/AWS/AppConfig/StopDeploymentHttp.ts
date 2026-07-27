import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Output from "../../Output.ts";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { Environment } from "./Environment.ts";
import { StopDeployment } from "./StopDeployment.ts";

/**
 * HTTP implementation of the {@link StopDeployment} binding. Calls
 * `appconfig:StopDeployment` with the Lambda's IAM role, scoped to the bound
 * environment's deployments.
 */
export const StopDeploymentHttp = makeAppConfigHttpBinding(StopDeployment, {
  operation: appconfig.stopDeployment,
  spec: (application: Application, environment: Environment) => ({
    identifiers: {
      ApplicationId: application.applicationId,
      EnvironmentId: environment.environmentId,
    },
    // The live authorizer evaluates the parent container ARNs (application,
    // environment) in addition to the deployment — observed via CloudTrail.
    iam: ({ region, accountId }) => ({
      actions: ["appconfig:StopDeployment"],
      resources: [
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}/deployment/*`,
      ],
    }),
  }),
});
