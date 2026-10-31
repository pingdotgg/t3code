import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  projectChangeRequestHost,
  type ChangeRequestHostIdentity,
  type ChangeRequestLink,
  type ParsedChangeRequestUrl,
} from "@t3tools/source-control-core/shared/definition";

import { icon } from "./icon.ts";

const KIND = SourceControlProviderKind.make("bitbucket-server");
const PR_PATH = /^(.*?)\/(projects|users)\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/u;

export function repositoryNameFromRemoteUrl(value: string): string | null {
  const path = URL.parse(value)?.pathname ?? /^[^@/]+@[^:]+:(.+)$/u.exec(value)?.[1];
  const match = path && /(?:^|\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(path);
  return match ? `${match[1]}/${match[2]}` : null;
}

function parseChangeRequestUrl(url: URL): ParsedChangeRequestUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = PR_PATH.exec(url.pathname);
  if (!match || !Number.isSafeInteger(Number(match[5])) || Number(match[5]) < 1) return null;
  return {
    host: url.hostname.toLowerCase(),
    ...(url.port ? { authority: url.host.toLowerCase() } : {}),
    repository: `${match[2] === "users" ? "~" : ""}${match[3]}/${match[4]}`.toLowerCase(),
    number: Number(match[5]),
    repositoryUrl: `${url.origin}${match[1]}/${match[2]}/${match[3]}/repos/${match[4]}`,
  };
}

function changeRequestHost(identity: ChangeRequestHostIdentity): string {
  for (const value of [identity?.webUrl, identity?.locator?.remoteUrl]) {
    const url = URL.parse(value ?? "");
    if (url && /^https?:$/u.test(url.protocol)) return url.host.toLowerCase();
  }
  return projectChangeRequestHost(identity, KIND);
}

function canReadChangeRequestOnHost(
  identity: ChangeRequestHostIdentity,
  link: Pick<ChangeRequestLink, "host" | "authority">,
) {
  return changeRequestHost(identity) === (link.authority ?? link.host).toLowerCase();
}

export const settings = makeProviderSettingsSchema(
  {
    url: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Host URL",
        description: "Include the context path if Bitbucket is served under one.",
        providerSettingsForm: { placeholder: "https://bitbucket.example.com" },
      }),
    ),
    token: SettingsSecretValue.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "HTTP access token",
        description:
          "A Data Center token with repository read access; repository write access is required to merge.",
        providerSettingsForm: { control: "password" },
      }),
    ),
  },
  { order: ["url", "token"] },
);
export type BitbucketServerSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Bitbucket Data Center",
  pickerLabel: "Bitbucket Data Center",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "PROJECTKEY/repo-slug",
  publicHost: null,
  publishDescription: "Your configured Data Center instance",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) => {
    if (webUrl) return `${webUrl.replace(/\/(browse)?$/u, "")}/pull-requests/${number}`;
    const [project, slug, ...rest] = repository.split("/");
    if (!project || !slug || rest.length > 0) return null;
    const remote = URL.parse(remoteUrl ?? "");
    if (!remote || !/^https?:$/u.test(remote.protocol)) return null;
    if (
      remote.hostname.toLowerCase() !== host.toLowerCase() &&
      remote.host.toLowerCase() !== host.toLowerCase()
    )
      return null;
    const root = `${remote.origin}${/^(.*?)\/scm\//u.exec(remote.pathname)?.[1] ?? ""}`;
    return `${root}/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}/pull-requests/${number}`;
  },
  parseChangeRequestUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["merge", "close", "reopen"] as const),
  changeRequestHeadRef: (number) => `refs/pull-requests/${number}/from`,
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (value) => {
    const url = URL.parse(value);
    return url !== null && parseChangeRequestUrl(url) !== null;
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ remoteUrl, host, hostname }) => {
    if (hostname === "bitbucket.org" || hostname.endsWith(".bitbucket.org")) return null;
    const url = URL.parse(remoteUrl);
    const mount =
      url && /^https?:$/u.test(url.protocol)
        ? /^(.*?)\/scm\/[^/]+\/[^/]+$/u.exec(url.pathname)
        : null;
    return hostname.split(".").includes("bitbucket") || mount !== null
      ? {
          kind: KIND,
          name: "Bitbucket Data Center",
          baseUrl: mount && url ? `${url.origin}${mount[1]}` : `https://${host}`,
        }
      : null;
  },
  changeRequestHost,
  isChangeRequestInRepository: (identity, link) =>
    canReadChangeRequestOnHost(identity, link) &&
    isChangeRequestInProjectRepository(changeRequestHost(identity), identity, link),
  canReadChangeRequestOnHost,
  settings,
});
