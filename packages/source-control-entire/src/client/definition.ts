import { pullRequestHostOf, SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
} from "@t3tools/source-control-core/client/definition";

import { ENTIRE_WEB_HOST, parseEntireTrailUrl } from "./entireUrls.ts";

const KIND = SourceControlProviderKind.make("entire");
const BRANCH = /^[A-Za-z0-9._/-]+$/u;

const isTrailUrl = (url: string) => parseEntireTrailUrl(url) !== null;

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Entire",
  pickerLabel: "Entire",
  icon: "entire",
  changeRequest: { shortLabel: "Trail", singular: "trail" },
  repositoryPathHint: "gh/owner/repo or et/project/repo",
  publicHost: ENTIRE_WEB_HOST,
  publishDescription: ENTIRE_WEB_HOST,
  publishHost: () => ENTIRE_WEB_HOST,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number }) =>
    `https://${ENTIRE_WEB_HOST}/${repository}/trails/${number}`,
  changeRequestActions: new Set([
    "ready",
    "draft",
    "close",
    "reopen",
    "merge",
    "update-branch",
  ] as const),
  // A bare number names a project trail to the CLI, so a change checks out by a plain branch.
  checkoutCommand: ({ headBranch }) =>
    BRANCH.test(headBranch) && !headBranch.startsWith("-")
      ? `entire trail checkout --branch ${headBranch}`
      : null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  // `entire trail checkout <n>` names a project trail, which is not one repository's change.
  checkoutCommandArgument: () => null,
  isChangeRequestReference: isTrailUrl,
  changeRequestUrlHost: (url) => (isTrailUrl(url.href) ? ENTIRE_WEB_HOST : url.hostname),
  checkoutChangeRequestHost: (identity) => pullRequestHostOf(identity, KIND),
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: isTrailUrl,
});
