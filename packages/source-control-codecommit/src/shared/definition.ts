import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import { defineSourceControl } from "@t3tools/source-control-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { icon } from "./icon.ts";

export type CodeCommitPartition = "aws" | "aws-cn" | "aws-us-gov";
export interface CodeCommitRepository {
  readonly region: string;
  readonly repository: string;
  readonly partition: CodeCommitPartition;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const REGION = /^(?:[a-z]{2}(?:-gov)?-[a-z]+-\d+)$/u;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const partitionForRegion = (region: string): CodeCommitPartition =>
  region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
const domainForPartition = (partition: CodeCommitPartition) =>
  partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
const consoleDomainForPartition = (partition: CodeCommitPartition) =>
  partition === "aws-cn"
    ? "amazonaws.cn"
    : partition === "aws-us-gov"
      ? "amazonaws-us-gov.com"
      : "aws.amazon.com";
const validRepository = ({ region, repository, partition }: CodeCommitRepository) =>
  REGION.test(region) &&
  REPOSITORY.test(repository) &&
  repository !== "." &&
  repository !== ".." &&
  !repository.toLowerCase().endsWith(".git") &&
  partitionForRegion(region) === partition;
const cloneHost = ({ region, partition }: CodeCommitRepository) =>
  `git-codecommit.${region}.${domainForPartition(partition)}`;

export function parseCodeCommitHelperRemote(remoteUrl: string): {
  readonly profile?: string;
  readonly region?: string;
  readonly repository: string;
} | null {
  const match =
    /^codecommit(?:::([a-z0-9-]+))?:\/\/(?:(?:([A-Za-z0-9_.-]+)@))?([A-Za-z0-9._-]{1,100})$/u.exec(
      remoteUrl.trim(),
    );
  if (
    !match?.[3] ||
    (match[1] && !REGION.test(match[1])) ||
    match[3] === "." ||
    match[3] === ".." ||
    match[3].toLowerCase().endsWith(".git")
  )
    return null;
  return {
    ...(match[1] ? { region: match[1] } : {}),
    ...(match[2] ? { profile: match[2] } : {}),
    repository: match[3],
  };
}

export function codeCommitRepositoryKey(
  input: CodeCommitRepository & { readonly accountId?: string },
): string {
  return `${cloneHost(input)}/${input.accountId ? `${input.accountId}/` : ""}v1/repos/${input.repository}`;
}

export function parseCodeCommitRemote(
  remoteUrl: string,
): (CodeCommitRepository & { readonly host: string }) | null {
  const value = remoteUrl.trim();
  const scp =
    /^(?:[^@/:]+@)?(git-codecommit\.[^/:]+\.(?:amazonaws\.com|amazonaws\.com\.cn)):(.+)$/iu.exec(
      value,
    );
  let host: string;
  let path: string;
  if (scp?.[1] && scp[2]) {
    host = scp[1].toLowerCase();
    path = `/${scp[2]}`;
  } else {
    const url = parseUrl(value);
    if (!url || !["https:", "ssh:"].includes(url.protocol) || url.port || url.search || url.hash)
      return null;
    host = url.hostname.toLowerCase();
    path = url.pathname;
  }
  const match = /^git-codecommit\.([a-z0-9-]+)\.(amazonaws\.com(?:\.cn)?)$/u.exec(host);
  const repository = /^\/v1\/repos\/([A-Za-z0-9._-]{1,100})\/?$/u.exec(path)?.[1];
  if (!match?.[1] || !repository) return null;
  const region = match[1];
  const partition = partitionForRegion(region);
  const result = { host, region, partition, repository };
  return validRepository(result) && match[2] === domainForPartition(partition) ? result : null;
}

export function codeCommitRepositoryUrl(input: CodeCommitRepository): string {
  return `https://${input.region}.console.${consoleDomainForPartition(input.partition)}/codesuite/codecommit/repositories/${encodeURIComponent(input.repository)}/browse?region=${input.region}`;
}
export function codeCommitCommitUrl(input: CodeCommitRepository, sha: string): string {
  return `https://${input.region}.console.${consoleDomainForPartition(input.partition)}/codesuite/codecommit/repositories/${encodeURIComponent(input.repository)}/commit/${sha}?region=${input.region}`;
}
export function codeCommitChangeRequestUrl(input: CodeCommitRepository, number: number): string {
  return `https://${input.region}.console.${consoleDomainForPartition(input.partition)}/codesuite/codecommit/repositories/${encodeURIComponent(input.repository)}/pull-requests/${number}/details?region=${input.region}`;
}

export function parseCodeCommitConsoleUrl(url: URL):
  | (CodeCommitRepository & {
      readonly host: string;
      readonly number?: number;
      readonly sha?: string;
    })
  | null {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const hostMatch =
    /^(?:([a-z0-9-]+)\.)?console\.(aws\.amazon\.com|amazonaws\.cn|amazonaws-us-gov\.com)$/u.exec(
      url.hostname,
    );
  if (!hostMatch) return null;
  const queryRegions = url.searchParams.getAll("region");
  if (queryRegions.length > 1) return null;
  const region = queryRegions[0] ?? hostMatch[1];
  if (!region || (hostMatch[1] && hostMatch[1] !== region)) return null;
  const partition = partitionForRegion(region);
  if (hostMatch[2] !== consoleDomainForPartition(partition)) return null;
  const repoMatch =
    /^\/codesuite\/codecommit\/repositories\/([^/]+)(?:\/(?:browse(?:\/.*)?|commit\/([0-9a-f]+)))?\/?$/iu.exec(
      url.pathname,
    );
  const prMatch =
    /^\/codesuite\/codecommit\/repositories\/([^/]+)\/pull-requests\/(\d+)(?:\/details)?\/?$/u.exec(
      url.pathname,
    );
  let repository: string;
  try {
    repository = decodeURIComponent(repoMatch?.[1] ?? prMatch?.[1] ?? "");
  } catch {
    return null;
  }
  const input = { region, repository, partition };
  if (!validRepository(input) || (!repoMatch && !prMatch)) return null;
  const sha = repoMatch?.[2];
  if (sha && !SHA.test(sha)) return null;
  const number = prMatch ? Number(prMatch[2]) : undefined;
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) return null;
  return {
    ...input,
    host: cloneHost(input),
    ...(sha ? { sha: sha.toLowerCase() } : {}),
    ...(number === undefined ? {} : { number }),
  };
}

const text = (annotations: Schema.Annotations.Key<string>) =>
  TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey(annotations),
  );
export const settings = makeProviderSettingsSchema(
  {
    profile: text({
      title: "AWS profile",
      description: "Leave blank to use the default AWS credential chain.",
    }),
    region: text({
      title: "AWS region",
      description: "Region used when creating repositories.",
      providerSettingsForm: { placeholder: "us-east-1" },
    }),
  },
  { order: ["profile", "region"] },
);
export type CodeCommitSettings = typeof settings.Type;

const KIND = SourceControlProviderKind.make("aws-codecommit");
function canonicalRepositoryKey(key: string): string | null {
  const match =
    /^(git-codecommit\.([a-z0-9-]+)\.(amazonaws\.com(?:\.cn)?))\/(?:(\d{12})\/)?v1\/repos\/([A-Za-z0-9._-]{1,100})$/u.exec(
      key.replace(/^[^/]+/u, (host) => host.toLowerCase()),
    );
  if (!match?.[2] || !match[5]) return null;
  const input = { region: match[2], partition: partitionForRegion(match[2]), repository: match[5] };
  return validRepository(input) && match[3] === domainForPartition(input.partition)
    ? codeCommitRepositoryKey({ ...input, ...(match[4] ? { accountId: match[4] } : {}) })
    : null;
}
function fromInput(input: {
  host: string;
  repository: string;
  remoteUrl?: string | undefined;
  webUrl?: string | undefined;
}): CodeCommitRepository | null {
  const remote = input.remoteUrl && parseCodeCommitRemote(input.remoteUrl);
  if (remote) return remote;
  const web = input.webUrl && parseUrl(input.webUrl);
  if (web) return parseCodeCommitConsoleUrl(web);
  return parseCodeCommitRemote(`https://${input.host}/${input.repository}`);
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "AWS CodeCommit",
  pickerLabel: "AWS CodeCommit",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "repository",
  publicHost: null,
  publishDescription: "AWS CodeCommit",
  publishHost: () => "AWS CodeCommit",
  newRepositoryOwner: () => null,
  repositoryVisibilities: ["private"] as const,
  repositoryNameOnly: true,
  caseSensitiveRepositoryPaths: true,
  defaultCloneTransport: "https",
  changeRequestUrl: (input) => {
    const repo = fromInput(input);
    return repo && Number.isSafeInteger(input.number) && input.number > 0
      ? codeCommitChangeRequestUrl(repo, input.number)
      : null;
  },
  commitUrl: (input) => {
    const repo = fromInput(input);
    return repo && SHA.test(input.sha) ? codeCommitCommitUrl(repo, input.sha.toLowerCase()) : null;
  },
  parseChangeRequestUrl: (url) => {
    const parsed = parseCodeCommitConsoleUrl(url);
    return parsed?.number
      ? {
          host: parsed.host,
          repository: `v1/repos/${parsed.repository}`,
          number: parsed.number,
          repositoryUrl: codeCommitRepositoryUrl(parsed),
        }
      : null;
  },
  parseCommitUrl: (url) => {
    const parsed = parseCodeCommitConsoleUrl(url);
    return parsed?.sha
      ? { host: parsed.host, repository: `v1/repos/${parsed.repository}`, sha: parsed.sha }
      : null;
  },
  repositoryUrlFromPage: (url) => {
    const parsed = parseCodeCommitConsoleUrl(url);
    return parsed ? `https://${parsed.host}/v1/repos/${parsed.repository}` : null;
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["merge", "close"]),
  closeIsFinal: true,
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (value) => {
    const url = parseUrl(value);
    return url !== null && parseCodeCommitConsoleUrl(url)?.number !== undefined;
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ remoteUrl }) => {
    const parsed = parseCodeCommitRemote(remoteUrl);
    return parsed
      ? { kind: KIND, name: "AWS CodeCommit", baseUrl: `https://${parsed.host}` }
      : parseCodeCommitHelperRemote(remoteUrl)
        ? { kind: KIND, name: "AWS CodeCommit", baseUrl: "https://codecommit" }
        : null;
  },
  repositorySelector: (identity) => {
    const name = identity.name ?? identity.displayName?.split("/").at(-1);
    return name ? `v1/repos/${name}` : null;
  },
  repositoryKeyFromRemote: (_key: string, remoteUrl: string) => {
    const parsed = parseCodeCommitRemote(remoteUrl);
    return parsed ? codeCommitRepositoryKey(parsed) : null;
  },
  canonicalRepositoryKey,
  isChangeRequestInRepository: (identity, link) => {
    const remote =
      parseCodeCommitRemote(identity.locator.remoteUrl) ??
      parseCodeCommitRemote(
        `https://${identity.canonicalKey.replace(/\/\d{12}\/v1\/repos\//u, "/v1/repos/")}`,
      );
    return (
      remote !== null &&
      remote.host === link.host &&
      `v1/repos/${remote.repository}` === link.repository
    );
  },
  canReadChangeRequestOnHost: (identity, link) =>
    (
      parseCodeCommitRemote(identity.locator.remoteUrl) ??
      parseCodeCommitRemote(
        `https://${identity.canonicalKey.replace(/\/\d{12}\/v1\/repos\//u, "/v1/repos/")}`,
      )
    )?.host === link.host &&
    parseCodeCommitRemote(`https://${link.host}/${link.repository}`) !== null,
  settings,
});
