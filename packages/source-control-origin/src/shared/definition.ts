import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

const REMOTE_HOST = "origin.cursor.com";
const WEB_HOSTS = new Set(["cursor.com", "www.cursor.com"]);
const CHANGE_REQUEST_PATH = /^\/codebase\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/codebase\/([^/]+\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;

function parseChangeRequestUrl(url: URL) {
  if (!WEB_HOSTS.has(url.hostname.toLowerCase())) return null;
  const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
  return link === null
    ? null
    : { ...link, repositoryUrl: `https://cursor.com/codebase/${link.repository}` };
}

const KIND = SourceControlProviderKind.make("origin");

export const settings = makeProviderSettingsSchema({
  token: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Cursor API key",
      description:
        "A Cursor API key, used before CURSOR_AUTH_TOKEN and the origin login. Minted through `origin auth token` (never sent as a Bearer token).",
      providerSettingsForm: { control: "password" },
    }),
  ),
});
export type OriginSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Origin",
  pickerLabel: "Origin (Cursor)",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "owner/repo",
  publicHost: REMOTE_HOST,
  publishDescription: "origin.cursor.com",
  publishHost: () => REMOTE_HOST,
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number }) =>
    `https://cursor.com/codebase/${repository}/pull/${number}`,
  parseChangeRequestUrl,
  commitUrl: ({ repository, sha }) => `https://cursor.com/codebase/${repository}/commit/${sha}`,
  parseCommitUrl: (url) =>
    WEB_HOSTS.has(url.hostname.toLowerCase()) ? parseCommitPath(url, COMMIT_PATH) : null,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["ready", "draft", "close", "reopen", "merge"] as const),
  checkoutCommand: ({ number }) => `origin pr checkout ${number}`,
  changeRequestCloseCommand: /\borigin\s+(?:pr|stack)\s+(?:merge|close)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => parsePullRequestUrl(url) !== null,
  checkoutChangeRequestHost: () => null,
  // Web URLs live on cursor.com; remotes live on origin.cursor.com.
  changeRequestHost: () => "cursor.com",
  recognizeRemote: ({ hostname }) =>
    hostname === REMOTE_HOST
      ? { kind: KIND, name: "Origin", baseUrl: `https://${REMOTE_HOST}` }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository("cursor.com", identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost("cursor.com", identity, link),
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
