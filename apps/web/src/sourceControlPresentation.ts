import { GitPullRequestIcon } from "lucide-react";
import type { ElementType } from "react";
import type { SourceControlProviderInfo, SourceControlProviderKind } from "@t3tools/contracts";
export {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  formatChangeRequestAction,
  formatCreateChangeRequestPhrase,
  getChangeRequestTerminology,
  resolveChangeRequestPresentation,
  type ChangeRequestPresentation,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import {
  getChangeRequestTerminology,
  resolveChangeRequestPresentation,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "./components/Icons";

export interface SourceControlPresentation {
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
  readonly Icon: ElementType<{ className?: string }>;
}

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  const presentation = resolveChangeRequestPresentation(provider);
  switch (presentation.icon) {
    case "github":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitHubIcon,
      };
    case "gitlab":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitLabIcon,
      };
    case "azure-devops":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: AzureDevOpsIcon,
      };
    case "bitbucket":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: BitbucketIcon,
      };
    case "change-request":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitPullRequestIcon,
      };
  }
}

/** For surfaces that know only the host kind, such as a change request row or filter. */
export function getSourceControlPresentationForKind(
  kind: SourceControlProviderKind,
): SourceControlPresentation {
  return getSourceControlPresentation({ kind, name: "", baseUrl: "" });
}
