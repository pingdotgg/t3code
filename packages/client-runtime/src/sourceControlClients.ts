import * as AzureDevOps from "@t3tools/source-control-azure-devops/client/definition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/client/definition";
import {
  HostCredentialSettings,
  makeSourceControlClientRegistry,
  readSourceControlHostSettings,
} from "@t3tools/source-control-core/client/definition";
import type { ServerSettings } from "@t3tools/contracts";

export {
  isMonochromeSourceControlIcon,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestLink,
  type ChangeRequestTerminology,
  type HostAccountChoice,
  type HostCredentialSettings,
  type ParsedChangeRequestUrl,
  type ReferenceAutolink,
  type SourceControlClientDefinition,
  type SourceControlHostCredentials,
  type SourceControlIcon,
} from "@t3tools/source-control-core/client/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/client/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/client/definition";
import * as GitHub from "@t3tools/source-control-github/client/definition";
import * as GitLab from "@t3tools/source-control-gitlab/client/definition";

/**
 * GitHub comes first because a repository that has not reported its host yet reads as GitHub,
 * which is what clients have always shown there. A change request URL goes to the first host
 * whose shape it has, so GitCafe, which claims `/pull/` and `/pulls/` only on its own hostnames,
 * claims before GitHub and Forgejo, which claim them everywhere. A hostname can carry more than
 * one host's label (`gitea.github.example`), so remote recognition has its own order. The server's
 * `sourceControl/sourceControlClients.ts` keeps the same order.
 */
const BUILT_IN_SOURCE_CONTROL_CLIENTS = [
  GitHub.definition,
  GitLab.definition,
  GitCafe.definition,
  Forgejo.definition,
  Bitbucket.definition,
  AzureDevOps.definition,
];

export const sourceControlClients = makeSourceControlClientRegistry(
  BUILT_IN_SOURCE_CONTROL_CLIENTS,
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

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
}

/** A host's change request term where it opens a sentence: "Merge request merged". */
export function capitalizeTerm(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}
