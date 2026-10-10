/**
 * Bitbucket's client definition. Browser- and React Native-safe.
 *
 * @module source-control-bitbucket/client/definition
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

const safeShellArgument = /^[A-Za-z0-9._/@+=,-]+$/;
const repositoryName = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const KIND = SourceControlProviderKind.make("bitbucket");

const text = (annotations: Schema.Annotations.Key<string>) =>
  TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey(annotations),
  );

/**
 * Bitbucket API credentials, used before the `T3CODE_BITBUCKET_*` environment variables: an
 * access token, or an Atlassian account email with an API token. The access token wins when both
 * are saved.
 */
export const settings = makeProviderSettingsSchema(
  {
    accessToken: text({
      title: "Access token",
      description:
        "Scoped to one repository, project, or workspace. Create it in that item's Bitbucket settings.",
      providerSettingsForm: { control: "password", secret: true },
    }),
    email: text({
      title: "Atlassian account email",
      description: "With an API token instead of an access token.",
      providerSettingsForm: { placeholder: "you@example.com" },
    }),
    apiToken: text({
      title: "API token",
      description:
        "Reaches every repository your Atlassian account can. Give it read and write access to repositories and pull requests, and read:user:bitbucket.",
      providerSettingsForm: { control: "password", secret: true },
    }),
  },
  { order: ["accessToken", "email", "apiToken"] },
);
export type BitbucketSettings = typeof settings.Type;

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Bitbucket",
  pickerLabel: "Bitbucket",
  icon: "bitbucket",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "workspace/repository",
  publicHost: "bitbucket.org",
  publishDescription: "bitbucket.org",
  publishHost: () => "bitbucket.org",
  // A new repository belongs to a workspace, which the signed-in account does not name.
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/pull-requests/${number}`,
  // No endpoint reopens a declined pull request, and nothing documented moves one in or out of
  // draft, so neither is offered rather than failing when pressed.
  changeRequestActions: new Set(["merge", "close"] as const),
  // Bitbucket has no checkout CLI, so clone the head branch from its own repository.
  checkoutCommand: ({ number, headBranch, headRepositoryNameWithOwner }) =>
    headRepositoryNameWithOwner &&
    repositoryName.test(headRepositoryNameWithOwner) &&
    safeShellArgument.test(headBranch)
      ? `git clone --single-branch --branch ${headBranch} https://bitbucket.org/${headRepositoryNameWithOwner}.git t3code-pr-${number}`
      : null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  // No checkout CLI, and the reference field never accepted Bitbucket URLs.
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/pull-requests/"),
  settings,
});
