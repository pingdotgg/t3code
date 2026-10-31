import * as AzureDevOps from "@t3tools/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";
import * as Origin from "@t3tools/source-control-origin/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 * GitCafe and Origin claim URLs first because other forges accept overlapping routes on any hostname.
 * Remote recognition needs its own order because host labels can overlap (`gitea.github.example`).
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    GitLab.definition,
    GitCafe.definition,
    Origin.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [
      Origin.definition.kind,
      GitCafe.definition.kind,
      AzureDevOps.definition.kind,
    ],
    recognizeRemotesIn: [
      Origin.definition.kind,
      GitCafe.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
