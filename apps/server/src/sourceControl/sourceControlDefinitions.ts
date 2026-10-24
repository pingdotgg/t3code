import * as AzureDevOpsDriver from "@t3tools/source-control-azure-devops/server/driver";
import * as BitbucketDriver from "@t3tools/source-control-bitbucket/server/driver";
import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as ForgejoDriver from "@t3tools/source-control-forgejo/server/driver";
import * as GitCafeDriver from "@t3tools/source-control-gitcafe/server/driver";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";

/**
 * The same order as the clients' registry in `@t3tools/client-runtime/source-control-clients`.
 * A change request URL goes to the first host whose shape it has, so GitCafe, which claims
 * `/pull/` and `/pulls/` only on its own hostnames, claims before GitHub and Forgejo, which
 * claim them everywhere. A remote goes to the first host that recognises it, and a hostname can
 * carry more than one host's label (`gitea.github.example`), so recognition has its own order.
 */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [
  GitHubDriver.driver,
  GitLabDriver.driver,
  GitCafeDriver.driver,
  ForgejoDriver.driver,
  BitbucketDriver.driver,
  AzureDevOpsDriver.driver,
] as const;

export const sourceControlDefinitions = makeSourceControlDefinitionRegistry(
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map((driver) => driver.definition),
  {
    claimChangeRequestUrlsFirst: [GitCafeDriver.driver.kind],
    recognizeRemotesIn: [
      GitCafeDriver.driver.kind,
      ForgejoDriver.driver.kind,
      GitHubDriver.driver.kind,
      GitLabDriver.driver.kind,
      AzureDevOpsDriver.driver.kind,
      BitbucketDriver.driver.kind,
    ],
  },
);
