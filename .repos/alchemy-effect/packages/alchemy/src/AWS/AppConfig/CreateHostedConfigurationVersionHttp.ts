import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Output from "../../Output.ts";
import type { Application } from "./Application.ts";
import { makeAppConfigHttpBinding } from "./BindingHttp.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";
import { CreateHostedConfigurationVersion } from "./CreateHostedConfigurationVersion.ts";

/**
 * HTTP implementation of the {@link CreateHostedConfigurationVersion}
 * binding. Calls `appconfig:CreateHostedConfigurationVersion` with the
 * Lambda's IAM role, scoped to the bound configuration profile and its
 * hosted versions.
 */
export const CreateHostedConfigurationVersionHttp = makeAppConfigHttpBinding(
  CreateHostedConfigurationVersion,
  {
    operation: appconfig.createHostedConfigurationVersion,
    spec: (
      application: Application,
      configurationProfile: ConfigurationProfile,
    ) => ({
      identifiers: {
        ApplicationId: application.applicationId,
        ConfigurationProfileId: configurationProfile.configurationProfileId,
      },
      // Per the service authorization reference, the action is authorized
      // against BOTH the application and the configuration profile.
      iam: ({ region, accountId }) => ({
        actions: ["appconfig:CreateHostedConfigurationVersion"],
        resources: [
          Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}`,
          Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}`,
          Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/configurationprofile/${configurationProfile.configurationProfileId}/hostedconfigurationversion/*`,
        ],
      }),
    }),
  },
);
