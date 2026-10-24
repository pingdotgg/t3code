import {
  type PullRequestAction,
  pullRequestHostOf,
  type PullRequestReviewVerdict,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The two strings are what `pullRequestHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because links are
 * matched against those. `authority` keeps the port for hosts whose identity includes it.
 */
export interface ChangeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly authority?: string;
}

export interface ParsedChangeRequestUrl extends ChangeRequestLink {
  /** The repository's browser URL, without query or hash. */
  readonly repositoryUrl: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export interface ChangeRequestUrlInput {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly remoteUrl?: string | undefined;
  /** The repository's browser URL; when given, the result is this plus the host's route. */
  readonly webUrl?: string | undefined;
}

export type ChangeRequestProjectIdentity = Pick<
  RepositoryIdentity,
  "canonicalKey" | "locator" | "webUrl" | "displayName" | "owner" | "name"
>;

export interface ChangeRequestCheckoutInput {
  readonly number: number;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null | undefined;
  readonly repositoryUrl?: string | null | undefined;
}

export interface SourceControlClientDefinition {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly pickerLabel: string;
  readonly icon: string;
  readonly changeRequest: ChangeRequestTerminology;
  readonly repositoryPathHint: string;
  readonly publicHost: string | null;
  readonly publishDescription: string;
  readonly publishHost: (signedInHost: string | null) => string;
  readonly newRepositoryOwner: (account: string | null) => { readonly owner: string | null } | null;
  readonly defaultCloneTransport: "https" | "ssh";
  readonly changeRequestUrl: (input: ChangeRequestUrlInput) => string | null;
  /** Null when the URL is not one of this host's change requests. */
  readonly parseChangeRequestUrl: (url: URL) => ParsedChangeRequestUrl | null;
  /**
   * The change request URL a bare `#123` autolink might name, for hosts that write every
   * reference through their issue route. Only a candidate: the caller must read it as a change
   * request before treating it as one.
   */
  readonly changeRequestUrlFromReferenceAutolink: (url: URL) => string | null;
  /**
   * The actions this host can take on a change request, the same list its server provider
   * declares in `capabilities.actions`.
   */
  readonly changeRequestActions: ReadonlySet<PullRequestAction>;
  readonly checkoutCommand: (changeRequest: ChangeRequestCheckoutInput) => string | null;
  readonly authorProfileUrl: (login: string, repositoryUrl: string) => string | null;
  readonly referenceAutolinkRepositoryUrl: (repositoryUrl: string) => string | null;
  readonly reviewSummaryRequired: (verdict: PullRequestReviewVerdict) => boolean;
  readonly checkoutCommandArgument: (input: string) => string | null;
  readonly isChangeRequestReference: (url: string) => boolean;
  readonly isChangeRequestInRepository: (
    identity: ChangeRequestProjectIdentity,
    link: ChangeRequestLink,
  ) => boolean;
  readonly canReadChangeRequestOnHost: (
    identity: ChangeRequestProjectIdentity,
    link: ChangeRequestLink,
  ) => boolean;
  readonly checkoutChangeRequestHost: (identity: ChangeRequestProjectIdentity) => string | null;
  readonly settings?: SourceControlHostSettingsSchema;
}

export type SourceControlHostSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Decoder<object>;

/**
 * Reads a change request from `url` with `route`, whose first group is the repository path and
 * second the number.
 */
export function parseChangeRequestPath(url: URL, route: RegExp): ParsedChangeRequestUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = route.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? {
        host: url.hostname.toLowerCase(),
        repository: repository.toLowerCase(),
        number,
        repositoryUrl: `${url.origin}/${repository}`,
      }
    : null;
}

export function changeRequestUrlBelow(webUrl: string, route: string): string {
  return `${webUrl.replace(/\/+$/u, "")}/${route}`;
}

/** An HTTP remote on `host` names the server's web origin, port included; SSH remotes do not. */
export function remoteWebOrigin(host: string, remoteUrl: string | undefined): string {
  try {
    const remote = new URL(remoteUrl ?? "");
    if (
      (remote.protocol === "http:" || remote.protocol === "https:") &&
      (remote.hostname.toLowerCase() === host.toLowerCase() ||
        remote.host.toLowerCase() === host.toLowerCase())
    ) {
      return remote.origin;
    }
  } catch {
    // SSH remotes do not specify the server's web origin.
  }
  return `https://${host}`;
}

export function defineSourceControlClient<const Definition extends SourceControlClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

export function isChangeRequestAuthorityOfProject(
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  if (link.authority === undefined) return true;
  try {
    const remote = new URL(identity.locator.remoteUrl);
    if (remote.protocol === "http:" || remote.protocol === "https:") {
      return remote.host.toLowerCase() === link.authority;
    }
  } catch {
    // SSH remotes do not specify the server's HTTP port.
  }
  return true;
}

export function isChangeRequestOnProjectHost(
  kind: SourceControlProviderKind,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
  const host = pullRequestHostOf(identity, kind);
  return host === link.host.toLowerCase() || host === link.authority;
}

function projectRepositoryPath(identity: ChangeRequestProjectIdentity): string | null {
  return (
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null)
  );
}

export function isChangeRequestInProjectRepository(
  kind: SourceControlProviderKind,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  const repository = projectRepositoryPath(identity);
  return (
    repository !== null &&
    repository.toLowerCase() === link.repository.toLowerCase() &&
    isChangeRequestOnProjectHost(kind, identity, link)
  );
}

export const UNKNOWN_SOURCE_CONTROL_CLIENT: SourceControlClientDefinition = {
  kind: SourceControlProviderKind.make("unknown"),
  label: "source control",
  pickerLabel: "source control",
  icon: "change-request",
  changeRequest: { shortLabel: "change request", singular: "change request" },
  repositoryPathHint: "URL",
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: () => null,
  parseChangeRequestUrl: () => null,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(),
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(SourceControlProviderKind.make("unknown"), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(SourceControlProviderKind.make("unknown"), identity, link),
};

export interface ParsedChangeRequest {
  readonly definition: SourceControlClientDefinition;
  readonly link: ParsedChangeRequestUrl;
}

export interface SourceControlClientRegistry {
  readonly definitions: ReadonlyArray<SourceControlClientDefinition>;
  readonly get: (kind: string | null | undefined) => SourceControlClientDefinition;
  readonly find: (kind: string) => SourceControlClientDefinition | undefined;
  readonly findByPublicHost: (hostname: string) => SourceControlClientDefinition | undefined;
  /** The first host, in registry order, that reads `url` as one of its change requests. */
  readonly parseChangeRequestUrl: (url: string) => ParsedChangeRequest | null;
  readonly findByChangeRequestUrl: (url: string) => SourceControlClientDefinition | undefined;
  readonly hostLabelForChangeRequestUrl: (url: string) => string;
  readonly isSameChangeRequest: (left: string, right: string) => boolean;
  readonly changeRequestUrlFromReferenceAutolink: (url: string) => string | null;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * `definitions` is display order, and its first entry is what `get` returns for a repository
 * that has not reported its host yet. A change request URL goes to the first definition that
 * reads it, trying `claimChangeRequestUrlsFirst` before the rest, so a host that claims a route
 * only on its own hostnames can precede one that claims the route everywhere.
 */
export function makeSourceControlClientRegistry(
  definitions: ReadonlyArray<SourceControlClientDefinition>,
  options?: { readonly claimChangeRequestUrlsFirst?: ReadonlyArray<SourceControlProviderKind> },
): SourceControlClientRegistry {
  const byKind = new Map<string, SourceControlClientDefinition>();
  for (const definition of definitions) {
    if (byKind.has(definition.kind)) {
      throw new Error(`Source control host '${definition.kind}' is defined more than once.`);
    }
    byKind.set(definition.kind, definition);
  }
  const first = new Set(options?.claimChangeRequestUrlsFirst);
  const claimOrder = [
    ...definitions.filter((definition) => first.has(definition.kind)),
    ...definitions.filter((definition) => !first.has(definition.kind)),
  ];
  const parseChangeRequestUrl = (value: string): ParsedChangeRequest | null => {
    const url = httpUrl(value);
    if (url === null) return null;
    for (const definition of claimOrder) {
      const link = definition.parseChangeRequestUrl(url);
      if (link !== null) return { definition, link };
    }
    return null;
  };
  return {
    definitions,
    get: (kind) =>
      (kind == null ? definitions[0] : byKind.get(kind)) ?? UNKNOWN_SOURCE_CONTROL_CLIENT,
    find: (kind) => byKind.get(kind),
    findByPublicHost: (hostname) => {
      const host = hostname.toLowerCase();
      return definitions.find((definition) => definition.publicHost === host);
    },
    parseChangeRequestUrl,
    findByChangeRequestUrl: (url) => parseChangeRequestUrl(url)?.definition,
    hostLabelForChangeRequestUrl: (url) =>
      parseChangeRequestUrl(url)?.definition.label ?? "the host",
    isSameChangeRequest: (left, right) => {
      const a = parseChangeRequestUrl(left)?.link;
      const b = parseChangeRequestUrl(right)?.link;
      return (
        a !== undefined &&
        b !== undefined &&
        a.host === b.host &&
        a.repository === b.repository &&
        a.number === b.number &&
        a.authority === b.authority
      );
    },
    changeRequestUrlFromReferenceAutolink: (value) => {
      const url = httpUrl(value);
      if (url === null) return null;
      for (const definition of claimOrder) {
        const candidate = definition.changeRequestUrlFromReferenceAutolink(url);
        if (candidate !== null) return candidate;
      }
      return null;
    },
  };
}

export function readSourceControlHostSettings<S extends SourceControlHostSettingsSchema>(
  schema: S,
  saved: unknown,
): S["Type"] {
  const decode = Schema.decodeUnknownOption(schema as Schema.Decoder<S["Type"]>);
  const decoded = decode(saved ?? {});
  if (decoded._tag === "Some") return decoded.value;
  const fallback = decode({});
  if (fallback._tag === "Some") return fallback.value;
  throw new Error("A source control host settings schema must decode an empty object.");
}
