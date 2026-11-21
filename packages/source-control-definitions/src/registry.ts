import * as AzureDevOps from "@lathe/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@lathe/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@lathe/source-control-core/shared/definition";
import * as CursorOrigin from "@lathe/source-control-cursor-origin/shared/definition";
import * as Forgejo from "@lathe/source-control-forgejo/shared/definition";
import * as GitCafe from "@lathe/source-control-gitcafe/shared/definition";
import * as GitHub from "@lathe/source-control-github/shared/definition";
import * as GitLab from "@lathe/source-control-gitlab/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@lathe/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 * GitCafe and Cursor Origin claim URLs first because GitHub and Forgejo accept the same routes on
 * any hostname.
 * Remote recognition needs its own order because host labels can overlap (`gitea.github.example`).
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    CursorOrigin.definition,
    GitLab.definition,
    GitCafe.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      AzureDevOps.definition.kind,
    ],
    recognizeRemotesIn: [
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
