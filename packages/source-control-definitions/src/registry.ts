import * as AzureDevOps from "@t3tools/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as Entire from "@t3tools/source-control-entire/shared/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 * GitCafe claims URLs first because GitHub and Forgejo accept the same routes on any hostname.
 * Remote recognition needs its own order because host labels can overlap (`gitea.github.example`),
 * and Entire claims an `entire://` remote by its scheme whatever the cluster is called.
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    GitLab.definition,
    GitCafe.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
    Entire.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [GitCafe.definition.kind, AzureDevOps.definition.kind],
    recognizeRemotesIn: [
      Entire.definition.kind,
      GitCafe.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
