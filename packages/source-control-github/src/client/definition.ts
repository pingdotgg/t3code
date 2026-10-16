import {
  GitHubHost,
  makeProviderSettingsSchema,
  secretSetting,
  pullRequestHostOf,
  SourceControlProviderKind,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

const CHECKOUT_COMMAND = /^gh\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;

const KIND = SourceControlProviderKind.make("github");

/**
 * An owner, or an `owner/name` repository, lowercased on decode: GitHub treats `PumpCade` and
 * `pumpcade` as one.
 */
const GitHubRuleKey = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.toLowerCase()),
);

export const GitHubHostChoice = Schema.Struct({
  account: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** The login that reads each owner's repositories, overriding `account` for them. */
  owners: Schema.optionalKey(Schema.Record(GitHubRuleKey, TrimmedNonEmptyString)),
  /** The login that reads one `owner/name` repository, overriding its owner's. */
  repositories: Schema.optionalKey(Schema.Record(GitHubRuleKey, TrimmedNonEmptyString)),
});
export type GitHubHostChoice = typeof GitHubHostChoice.Type;

/**
 * The logins Settings choose for a repository on a host, given as `owner/name` or just its owner,
 * most specific first: the repository's own rule, its owner's, then the host's pinned account.
 * None leaves the choice to `gh`; a login `gh` no longer holds gives way to the next.
 */
export function gitHubAccountsFor(
  choice: GitHubHostChoice | undefined,
  repository: string | null | undefined,
): ReadonlyArray<string> {
  const key = repository?.trim().toLowerCase();
  const owner = key?.split("/")[0];
  const chosen = [
    key && key.includes("/") ? choice?.repositories?.[key] : undefined,
    owner ? choice?.owners?.[owner] : undefined,
    choice?.account,
  ].filter((account): account is string => account !== undefined);
  return [...new Set(chosen)];
}

/** The most specific login Settings choose for a repository on a host, if any. */
export function gitHubAccountFor(
  choice: GitHubHostChoice | undefined,
  repository: string | null | undefined,
): string | undefined {
  return gitHubAccountsFor(choice, repository)[0];
}

export const settings = makeProviderSettingsSchema({
  hosts: Schema.Record(GitHubHost, GitHubHostChoice).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  tokens: Schema.Record(GitHubHost, TrimmedString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    secretSetting,
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type GitHubSettings = typeof settings.Type;

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "GitHub",
  pickerLabel: "GitHub",
  icon: "github",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  publicHost: "github.com",
  publishDescription: "github.com",
  publishHost: () => "github.com",
  newRepositoryOwner: (account) => ({ owner: account }),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/pull/${number}`,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "delete-branch",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ] as const),
  checkoutCommand: ({ number }) => `gh pr checkout ${number}`,
  authorProfileUrl: (login, repositoryUrl) =>
    login.endsWith("[bot]")
      ? null
      : new URL(`/${encodeURIComponent(login)}`, repositoryUrl).toString(),
  referenceAutolinkRepositoryUrl: (repositoryUrl) => repositoryUrl,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: (identity) => pullRequestHostOf(identity, KIND),
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/pull/"),
  settings,
});
