import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

/** GitCafe has no self-hosted installs: production and staging are its only hosts. */
const GITCAFE_HOSTS = new Set(["git.cafe", "staging.git.cafe"]);

/** GitCafe serves pull requests at `/pull/<n>` and redirects the older `/pulls/<n>` there. */
const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;

function parseChangeRequestUrl(url: URL) {
  return GITCAFE_HOSTS.has(url.hostname.toLowerCase())
    ? parseChangeRequestPath(url, CHANGE_REQUEST_PATH)
    : null;
}

const KIND = SourceControlProviderKind.make("gitcafe");

export const settings = makeProviderSettingsSchema({
  token: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Token",
      description:
        "A git.cafe token, used before CAFE_TOKEN and the cafe login, so GitCafe works without the CLI signed in.",
      providerSettingsForm: { control: "password" },
    }),
  ),
});
export type GitCafeSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "GitCafe",
  pickerLabel: "GitCafe",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "owner/repo",
  publicHost: "git.cafe",
  publishDescription: "git.cafe",
  publishHost: () => "git.cafe",
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `pulls/${number}`)
      : `https://${host}/${repository}/pulls/${number}`,
  // `/pull/` and `/pulls/` are GitHub's and Forgejo's shapes too, so only GitCafe's own hosts
  // claim them.
  parseChangeRequestUrl,
  commitUrl: (input) => buildCommitUrl(input, "commit"),
  parseCommitUrl: (url) =>
    GITCAFE_HOSTS.has(url.hostname.toLowerCase()) ? parseCommitPath(url, COMMIT_PATH) : null,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set([
    "ready",
    "draft",
    "close",
    "reopen",
    "merge",
    "update-branch",
  ] as const),
  checkoutCommand: ({ number }) => `cafe pr checkout ${number}`,
  changeRequestCloseCommand: /\bcafe\s+(?:pr|stack)\s+(?:merge|close)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => parsePullRequestUrl(url) !== null,
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ hostname }) =>
    GITCAFE_HOSTS.has(hostname)
      ? { kind: KIND, name: "GitCafe", baseUrl: `https://${hostname}` }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  settings,
});

export function parsePullRequestUrl(value: string) {
  try {
    return parseChangeRequestUrl(new URL(value));
  } catch {
    return null;
  }
}

export function canonicalizePullRequestUrl(value: string): string {
  const link = parsePullRequestUrl(value);
  return link === null ? value : definition.changeRequestUrl(link);
}
