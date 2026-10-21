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

export const settings = makeProviderSettingsSchema(
  {
    accessToken: text({
      title: "Access token",
      description:
        "Scoped to one repository, project, or workspace. Create it in that item's Bitbucket settings.",
      settingsSecret: true,
      providerSettingsForm: { control: "password" },
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
      settingsSecret: true,
      providerSettingsForm: { control: "password" },
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
  // The signed-in account does not identify a workspace.
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/pull-requests/${number}`,
  // Bitbucket has no reopen or documented draft-state endpoint.
  changeRequestActions: new Set(["merge", "close"] as const),
  // Bitbucket has no checkout CLI.
  checkoutCommand: ({ number, headBranch, headRepositoryNameWithOwner }) =>
    headRepositoryNameWithOwner &&
    repositoryName.test(headRepositoryNameWithOwner) &&
    safeShellArgument.test(headBranch)
      ? `git clone --single-branch --branch ${headBranch} https://bitbucket.org/${headRepositoryNameWithOwner}.git t3code-pr-${number}`
      : null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
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
