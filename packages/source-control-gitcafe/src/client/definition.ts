import {
  makeProviderSettingsSchema,
  secretSetting,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  changeRequestUrlBelow,
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

/** GitCafe has no self-hosted installs: production and staging are its only hosts. */
const GITCAFE_HOSTS = new Set(["git.cafe", "staging.git.cafe"]);

/** GitCafe serves pull requests at `/pull/<n>` and redirects the older `/pulls/<n>` there. */
const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:\/|$)/u;

const KIND = SourceControlProviderKind.make("gitcafe");

export const settings = makeProviderSettingsSchema({
  token: TrimmedString.pipe(
    secretSetting,
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

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "GitCafe",
  pickerLabel: "GitCafe",
  icon: "gitcafe",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  publicHost: null,
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
  parseChangeRequestUrl: (url) =>
    GITCAFE_HOSTS.has(url.hostname.toLowerCase())
      ? parseChangeRequestPath(url, CHANGE_REQUEST_PATH)
      : null,
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
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  settings,
});
