import * as AzureDevOps from "@t3tools/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-gitcafe/shared/definition";

/**
 * The server and every client read hosts through this one registry, so they agree on which host
 * owns a URL or remote. GitHub comes first because a repository that has not reported its host
 * yet reads as GitHub, which is what clients have always shown there. A change request URL goes
 * to the first host whose shape it has, so GitCafe, which claims `/pull/` and `/pulls/` only on
 * its own hostnames, claims before GitHub and Forgejo, which claim them everywhere. A hostname can
 * carry more than one host's label (`gitea.github.example`), so remote recognition has its own
 * order.
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    GitLab.definition,
    GitCafe.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [GitCafe.definition.kind],
    recognizeRemotesIn: [
      GitCafe.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
