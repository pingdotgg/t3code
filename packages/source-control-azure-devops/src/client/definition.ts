/**
 * Azure DevOps's client definition. Browser- and React Native-safe.
 *
 * @module source-control-azure-devops/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import {
  defineSourceControlClient,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

export const definition = defineSourceControlClient({
  kind: SourceControlProviderKind.make("azure-devops"),
  label: "Azure DevOps",
  pickerLabel: "Azure DevOps",
  icon: "azure-devops",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "project/repository",
  // `az repos` reads need the checkout's organization and project, so a bare hostname names no
  // repository this client can act on.
  publicHost: null,
  publishDescription: "dev.azure.com",
  publishHost: () => "dev.azure.com",
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${canonicalRepositoryKey(`${host}/${repository}`.toLowerCase())}/pullrequest/${number}`,
  checkoutCommand: ({ number }) => `az repos pr checkout --id ${number}`,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/pullrequest/"),
});
