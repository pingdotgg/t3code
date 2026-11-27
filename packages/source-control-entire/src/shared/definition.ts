import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";

import {
  ENTIRE_CHANGE_PATH,
  ENTIRE_WEB_HOST,
  parseEntireTrailUrl,
  WEB_HOSTS,
} from "./entireUrls.ts";
import { icon } from "./icon.ts";

const KIND = SourceControlProviderKind.make("entire");
const BRANCH = /^[A-Za-z0-9._/-]+$/u;

function parseChangeRequestUrl(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!WEB_HOSTS.has(url.hostname.toLowerCase())) return null;
  const [, forge, owner, projectRepository, repository, digits] =
    ENTIRE_CHANGE_PATH.exec(url.pathname) ?? [];
  const number = Number(digits);
  if (!forge || !Number.isSafeInteger(number)) return null;
  // entire.io links name the same change as entire.com ones, and a change linked through its
  // project trail has no repository prefix to cut back to.
  const path = `${forge}/${owner}/${projectRepository ?? repository}`.toLowerCase();
  return {
    host: ENTIRE_WEB_HOST,
    repository: path,
    number,
    repositoryUrl: `https://${ENTIRE_WEB_HOST}/${path}`,
  };
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "Entire",
  pickerLabel: "Entire",
  icon,
  changeRequest: {
    shortLabel: "trail",
    shortLabelWithArticle: "a trail",
    singular: "trail",
    plural: "trails",
  },
  repositoryPathHint: "gh/owner/repo or et/project/repo",
  publicHost: ENTIRE_WEB_HOST,
  publishDescription: ENTIRE_WEB_HOST,
  publishHost: () => ENTIRE_WEB_HOST,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number }) =>
    `https://${ENTIRE_WEB_HOST}/${repository}/trails/${number}`,
  parseChangeRequestUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
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
  reviewSummaryRequired: () => false,
  // `entire trail checkout <n>` names a project trail, which is not one repository's change.
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => parseEntireTrailUrl(url) !== null,
  checkoutChangeRequestHost: (identity) => projectChangeRequestHost(identity, KIND),
  // An `entire://` remote names a cluster, not a forge: every cluster is Entire's, whatever its
  // hostname, and Entire's https hosts are never claimed by name.
  recognizeRemote: ({ remoteUrl }) =>
    /^entire:\/\//iu.test(remoteUrl)
      ? { kind: KIND, name: "Entire", baseUrl: `https://${ENTIRE_WEB_HOST}` }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});
