import * as AzureDevOps from "@t3tools/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as CursorOrigin from "@t3tools/source-control-cursor-origin/shared/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";
import * as TanStackSource from "@t3tools/source-control-tanstack-source/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first as the client default for unknown hosts. GitCafe, TanStack Source and Origin
 * claim URLs first: GitHub and Forgejo accept the same routes on any hostname. TanStack Source is a
 * private beta a server may leave out; clients always know it, for a server that has it.
 */
export function makeBuiltInSourceControlDefinitions(options: { readonly tanStackSource: boolean }) {
  const tanStackSource = options.tanStackSource ? [TanStackSource.definition] : [];
  return makeSourceControlDefinitionRegistry(
    [
      GitHub.definition,
      CursorOrigin.definition,
      GitLab.definition,
      GitCafe.definition,
      ...tanStackSource,
      Forgejo.definition,
      Bitbucket.definition,
      AzureDevOps.definition,
    ],
    {
      claimChangeRequestUrlsFirst: [
        GitCafe.definition.kind,
        ...tanStackSource.map((definition) => definition.kind),
        CursorOrigin.definition.kind,
        AzureDevOps.definition.kind,
      ],
      recognizeRemotesIn: [
        GitCafe.definition.kind,
        ...tanStackSource.map((definition) => definition.kind),
        CursorOrigin.definition.kind,
        Forgejo.definition.kind,
        GitHub.definition.kind,
        GitLab.definition.kind,
        AzureDevOps.definition.kind,
        Bitbucket.definition.kind,
      ],
    },
  );
}

export const builtInSourceControlDefinitions = makeBuiltInSourceControlDefinitions({
  tanStackSource: true,
});
