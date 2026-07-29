import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Output from "../../Output.ts";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";
import type { DeploymentStrategy } from "./DeploymentStrategy.ts";
import type { Environment } from "./Environment.ts";
import { StartDeployment } from "./StartDeployment.ts";

/**
 * HTTP implementation of the {@link StartDeployment} binding. Calls
 * `appconfig:StartDeployment` with the Lambda's IAM role, scoped to the bound
 * application, environment, configuration profile, and deployment strategy.
 */
export const StartDeploymentHttp = makeAppConfigHttpBinding(StartDeployment, {
  operation: appconfig.startDeployment,
  spec: (
    application: Application,
    environment: Environment,
    configurationProfile: ConfigurationProfile,
    deploymentStrategy: DeploymentStrategy,
  ) => ({
    identifiers: {
      ApplicationId: application.applicationId,
      EnvironmentId: environment.environmentId,
      ConfigurationProfileId: configurationProfile.configurationProfileId,
      DeploymentStrategyId: deploymentStrategy.deploymentStrategyId,
    },
    iam: ({ region, accountId }) => ({
      actions: ["appconfig:StartDeployment"],
      resources: [
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}`,
        Output.interpolate`arn:aws:appconfig:${region}:${accountId}:deploymentstrategy/${deploymentStrategy.deploymentStrategyId}`,
      ],
    }),
  }),
});
