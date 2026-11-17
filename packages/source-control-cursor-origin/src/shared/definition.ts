import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  type ParsedChangeRequestUrl,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

/** Origin's git host; its browser pages live under `cursor.com/codebase` instead. */
export const CURSOR_ORIGIN_GIT_HOST = "origin.cursor.com";
export const CURSOR_ORIGIN_WEB_BASE_URL = "https://cursor.com/codebase";

const CHECKOUT_COMMAND = /^origin\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_PATH = /^\/codebase\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u;

const KIND = SourceControlProviderKind.make("cursor-origin");

/** A cursor.com page names a repository on Origin's git host, which is what projects key under. */
export function parseChangeRequestUrl(url: URL): ParsedChangeRequestUrl | null {
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (hostname !== "cursor.com" && hostname !== "www.cursor.com") return null;
  const match = CHANGE_REQUEST_PATH.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? {
        host: CURSOR_ORIGIN_GIT_HOST,
        repository: repository.toLowerCase(),
        number,
        repositoryUrl: `${CURSOR_ORIGIN_WEB_BASE_URL}/${repository}`,
      }
    : null;
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "Cursor Origin",
  pickerLabel: "Cursor Origin",
  icon,
  searchKeywords: ["cursor", "origin"],
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "owner/repo",
  publicHost: CURSOR_ORIGIN_GIT_HOST,
  publishDescription: CURSOR_ORIGIN_GIT_HOST,
  publishHost: () => CURSOR_ORIGIN_GIT_HOST,
  newRepositoryOwner: (account) => ({ owner: account }),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number }) =>
    `${CURSOR_ORIGIN_WEB_BASE_URL}/${repository}/pull/${number}`,
  parseChangeRequestUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["merge", "ready", "draft", "close", "reopen"] as const),
  checkoutCommand: ({ number }) => `origin pr checkout ${number}`,
  changeRequestCloseCommand: /\borigin\s+pr\s+(?:merge|close)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => {
    try {
      return parseChangeRequestUrl(new URL(url)) !== null;
    } catch {
      return false;
    }
  },
  checkoutChangeRequestHost: (identity) => projectChangeRequestHost(identity, KIND),
  recognizeRemote: ({ hostname }) =>
    hostname === CURSOR_ORIGIN_GIT_HOST
      ? { kind: KIND, name: "Cursor Origin", baseUrl: CURSOR_ORIGIN_WEB_BASE_URL }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});
