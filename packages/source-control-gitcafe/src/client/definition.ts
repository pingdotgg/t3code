/**
 * GitCafe's client definition. Browser- and React Native-safe.
 *
 * @module source-control-gitcafe/client/definition
 */
import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

/** GitCafe has no self-hosted installs: production and staging are its only hosts. */
const GITCAFE_HOSTS = new Set(["git.cafe", "staging.git.cafe"]);

const KIND = SourceControlProviderKind.make("gitcafe");

/** A git.cafe token, used before `CAFE_TOKEN` and the `cafe` login. */
export const settings = makeProviderSettingsSchema({
  token: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Token",
      description:
        "A git.cafe token, used before CAFE_TOKEN and the cafe login, so GitCafe works without the CLI signed in.",
      providerSettingsForm: { control: "password", secret: true },
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
  // Left unattributed so a reference with no repository identity behind it gets no checkout
  // command guessed from its hostname alone.
  publicHost: null,
  publishDescription: "git.cafe",
  publishHost: () => "git.cafe",
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/pulls/${number}`,
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
  // `/pulls/` is Forgejo's shape too, so only GitCafe's own hosts claim it.
  // `cafe pr checkout` and git.cafe URLs were never accepted in reference fields.
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => {
    try {
      return (
        GITCAFE_HOSTS.has(new URL(url).hostname.toLowerCase()) &&
        isChangeRequestPath(url, "/pulls/")
      );
    } catch {
      return false;
    }
  },
  settings,
});
