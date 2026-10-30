import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
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

const safeShellArgument = /^[A-Za-z0-9._/@+=,-]+$/;
const repositoryName = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/?$/iu;

const KIND = SourceControlProviderKind.make("bitbucket");

function isBitbucketHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "bitbucket.org" ||
    host.endsWith(".bitbucket.org") ||
    host.split(".").includes("bitbucket")
  );
}

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

export const definition = defineSourceControl({
  kind: KIND,
  label: "Bitbucket",
  pickerLabel: "Bitbucket",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "workspace/repository",
  publicHost: "bitbucket.org",
  publishDescription: "bitbucket.org",
  publishHost: () => "bitbucket.org",
  // The signed-in account does not identify a workspace.
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `pull-requests/${number}`)
      : `https://${host}/${repository}/pull-requests/${number}`,
  parseChangeRequestUrl: (url) =>
    isBitbucketHost(url.hostname) ? parseChangeRequestPath(url, CHANGE_REQUEST_PATH) : null,
  commitUrl: (input) => buildCommitUrl(input, "commits"),
  parseCommitUrl: (url) =>
    isBitbucketHost(url.hostname) ? parseCommitPath(url, COMMIT_PATH) : null,
  changeRequestUrlFromReferenceAutolink: () => null,
  // No endpoint reopens a declined pull request, and nothing documented moves one in or out of
  // draft, so neither is offered rather than failing when pressed.
  changeRequestActions: new Set(["merge", "close"] as const),
  // Bitbucket has no checkout CLI.
  checkoutCommand: ({ number, headBranch, headRepositoryNameWithOwner }) =>
    headRepositoryNameWithOwner &&
    repositoryName.test(headRepositoryNameWithOwner) &&
    safeShellArgument.test(headBranch)
      ? `git clone --single-branch --branch ${headBranch} https://bitbucket.org/${headRepositoryNameWithOwner}.git t3code-pr-${number}`
      : null,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (reference) => {
    const url = URL.parse(reference);
    return (
      url !== null &&
      isBitbucketHost(url.hostname) &&
      parseChangeRequestPath(url, CHANGE_REQUEST_PATH) !== null
    );
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ host, hostname }) =>
    hostname === "bitbucket.org" || hostname.split(".").includes("bitbucket")
      ? {
          kind: KIND,
          name: hostname === "bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted",
          baseUrl: `https://${host}`,
        }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  settings,
});
