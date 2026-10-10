/**
 * GitLab's client definition. Browser- and React Native-safe.
 *
 * @module source-control-gitlab/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

export const definition = defineSourceControlClient({
  kind: SourceControlProviderKind.make("gitlab"),
  label: "GitLab",
  pickerLabel: "GitLab",
  icon: "gitlab",
  changeRequest: { shortLabel: "MR", singular: "merge request" },
  repositoryPathHint: "group/project",
  publicHost: "gitlab.com",
  publishDescription: "gitlab.com",
  publishHost: () => "gitlab.com",
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/-/merge_requests/${number}`,
  checkoutCommand: ({ number }) => `glab mr checkout ${number}`,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/-/merge_requests/"),
});
