import {
  type PullRequestAction,
  type PullRequestReviewVerdict,
  type RepositoryIdentity,
  SourceControlProviderKind,
  type SourceControlProviderInfo,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl, parseGitRemoteRepository } from "@t3tools/shared/git";
import * as Schema from "effect/Schema";

/**
 * The two strings are what `changeRequestHost` and the project's `repositoryIdentity` produce
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

export type ChangeRequestHostIdentity =
  | {
      readonly canonicalKey?: string | undefined;
      readonly locator?: { readonly remoteUrl: string } | undefined;
    }
  | null
  | undefined;

export type RepositorySelectorIdentity = Pick<
  RepositoryIdentity,
  "provider" | "displayName" | "owner" | "name"
>;

/** A git remote's host, as `recognizeRemote` reads it. */
export interface GitRemoteHost {
  /** Trimmed. */
  readonly remoteUrl: string;
  /** Lower case. Keeps the port of an HTTP remote, never an SSH one. */
  readonly host: string;
  /** `host` without its port. */
  readonly hostname: string;
}

export interface ChangeRequestCheckoutInput {
  readonly number: number;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null | undefined;
  readonly repositoryUrl?: string | null | undefined;
}

/** Media a host serves only to a request carrying a credential, as `mediaUrl` reads it. */
export interface SourceControlMediaUrl {
  /** The canonical URL to fetch, the same for every spelling of one file. */
  readonly fetchUrl: string;
  /** A file name for the media, safe to put in a path or a download. */
  readonly fileName: string;
  /** Set when the URL alone says what the media is, as an extensionless upload can. */
  readonly kind?: "image" | "video";
}

export interface ReferenceAutolink {
  /** Where `text` starts in the string that was searched. */
  readonly index: number;
  readonly text: string;
  /** What to show for the link, which can be shorter than `text`, as for a commit SHA. */
  readonly label: string;
  readonly url: string;
  readonly kind: "reference" | "commit" | "mention";
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
  /**
   * Matches a shell command that merges or closes a change request with this host's CLI, which
   * sends T3 no notification of its own. Absent for a host with no such CLI.
   */
  readonly changeRequestCloseCommand?: RegExp;
  readonly authorProfileUrl: (login: string, repositoryUrl: string) => string | null;
  /**
   * The references this host's own renderer links in plain text, such as `#12` or a commit SHA,
   * resolved against `repositoryUrl`, in the order they appear. Absent for a host whose grammar
   * T3 does not apply.
   */
  readonly referenceAutolinks?: (
    text: string,
    repositoryUrl: string,
  ) => ReadonlyArray<ReferenceAutolink>;
  /** Where the host lists a change request's checks. Absent means the change request's own page. */
  readonly changeRequestChecksUrl?: (changeRequestUrl: string) => string;
  /**
   * The actions a server too old to report `capabilities.actions` could still take on this host's
   * change requests. Absent means none.
   */
  readonly changeRequestActionsWhenUnreported?: ReadonlySet<PullRequestAction>;
  /**
   * `host` when the server lists change requests in many repositories on this host with one read,
   * so a page's size bounds the rows of every repository together. Absent means one read per
   * repository.
   */
  readonly changeRequestListScope?: "host" | "repository";
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
  /**
   * The ref the target repository publishes change request `number`'s head under, which names the
   * head even when it lives in a fork. Absent for a host that publishes none.
   */
  readonly changeRequestHeadRef?: (number: number) => string;
  /** Null when this host does not claim the remote. Asked in the registry's recognition order. */
  readonly recognizeRemote: (remote: GitRemoteHost) => SourceControlProviderInfo | null;
  /** The host change requests in the project are listed and keyed under. */
  readonly changeRequestHost?: (identity: ChangeRequestHostIdentity) => string;
  /**
   * What the host's tools take to select the project's repository. Absent means the repository
   * path, `owner/name`.
   */
  readonly repositorySelector?: (identity: RepositorySelectorIdentity) => string | null;
  /**
   * For a host that spells one repository differently over SSH and on the web: the web spelling
   * of the `host/path` key `normalizeGitRemoteUrl` made from a remote that names a host. Null when
   * the key is not this host's. Persisted repository keys are built with it, so its output must
   * not change.
   */
  readonly repositoryKeyFromRemote?: (key: string) => string | null;
  /**
   * For a host with more than one spelling of a repository key: the one every spelling compares
   * equal under. Null when the key is not this host's.
   */
  readonly canonicalRepositoryKey?: (key: string) => string | null;
  /**
   * An SSH remote names the SSH server only, so the web host, and its port, come from resolving
   * the provider rather than from the remote.
   */
  readonly sshRemoteHidesWebHost?: boolean;
  /**
   * Null when `url` is not media this host keeps behind a credential. A client cannot load such
   * media itself, so it asks the server, whose driver for this host fetches it.
   */
  readonly mediaUrl?: (url: URL) => SourceControlMediaUrl | null;
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

/** The host of the project's repository key, or `kind` when the key has none. */
export function projectChangeRequestHost<const Kind extends string | undefined>(
  identity: ChangeRequestHostIdentity,
  kind: Kind,
): string | Kind {
  const host = identity?.canonicalKey?.split("/")[0]?.trim();
  return host === undefined || host.length === 0 ? kind : host.toLowerCase();
}

/** `projectHost` is the project's `changeRequestHost`. */
export function isChangeRequestOnProjectHost(
  projectHost: string,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
  return projectHost === link.host.toLowerCase() || projectHost === link.authority;
}

function projectRepositoryPath(identity: ChangeRequestProjectIdentity): string | null {
  return (
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null)
  );
}

export function isChangeRequestInProjectRepository(
  projectHost: string,
  identity: ChangeRequestProjectIdentity,
  link: ChangeRequestLink,
): boolean {
  const repository = projectRepositoryPath(identity);
  return (
    repository !== null &&
    repository.toLowerCase() === link.repository.toLowerCase() &&
    isChangeRequestOnProjectHost(projectHost, identity, link)
  );
}

const SCP_REMOTE = /^[a-zA-Z0-9._-]+@([^:/]+):/;

/** Null when the remote names no host, such as a local path. */
export function parseGitRemoteHost(remoteUrl: string): GitRemoteHost | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;
  let host: string;
  const scpHost = SCP_REMOTE.exec(trimmed)?.[1];
  if (scpHost) {
    host = scpHost.toLowerCase();
  } else {
    try {
      const url = new URL(trimmed);
      host = (url.protocol === "ssh:" ? url.hostname : url.host).toLowerCase();
    } catch {
      return null;
    }
  }
  if (host.length === 0) return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    hostname = host.replace(/:\d+$/u, "").toLowerCase();
  }
  return { remoteUrl: trimmed, host, hostname };
}

/** What a remote on a host no definition claims reads as. */
export function unknownRemoteProvider(remote: GitRemoteHost): SourceControlProviderInfo {
  return {
    kind: SourceControlProviderKind.make("unknown"),
    name: remote.host,
    baseUrl: `https://${remote.host}`,
  };
}

/** What `definition` alone makes of a remote, for a host's own code that asks only about itself. */
export function recognizeRemoteWith(
  definition: Pick<SourceControlClientDefinition, "recognizeRemote">,
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const remote = parseGitRemoteHost(remoteUrl);
  return remote === null ? null : definition.recognizeRemote(remote);
}

function defaultRepositorySelector(
  identity: RepositorySelectorIdentity | null | undefined,
): string | null {
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
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
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  checkoutChangeRequestHost: () => null,
  recognizeRemote: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(
      projectChangeRequestHost(identity, "unknown"),
      identity,
      link,
    ),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, "unknown"), identity, link),
};

export interface ParsedChangeRequest {
  readonly definition: SourceControlClientDefinition;
  readonly link: ParsedChangeRequestUrl;
}

export interface SourceControlMedia extends SourceControlMediaUrl {
  readonly definition: SourceControlClientDefinition;
}

export interface SourceControlClientRegistry {
  readonly definitions: ReadonlyArray<SourceControlClientDefinition>;
  readonly get: (kind: string | null | undefined) => SourceControlClientDefinition;
  readonly find: (kind: string) => SourceControlClientDefinition | undefined;
  readonly findByPublicHost: (hostname: string) => SourceControlClientDefinition | undefined;
  /**
   * The host whose `publicHost` is `hostname` or a parent domain of it, such as GitHub for
   * `gist.github.com`: which host a link is on, not one T3 can read from.
   */
  readonly findByPublicDomain: (hostname: string) => SourceControlClientDefinition | undefined;
  /** The first host, in registry order, that reads `url` as one of its change requests. */
  readonly parseChangeRequestUrl: (url: string) => ParsedChangeRequest | null;
  readonly findByChangeRequestUrl: (url: string) => SourceControlClientDefinition | undefined;
  readonly hostLabelForChangeRequestUrl: (url: string) => string;
  readonly isSameChangeRequest: (left: string, right: string) => boolean;
  readonly changeRequestUrlFromReferenceAutolink: (url: string) => string | null;
  /**
   * The host a remote is on, from the first definition in recognition order that claims it, or an
   * unknown host. Null when the remote names no host.
   */
  readonly recognizeRemote: (remoteUrl: string) => SourceControlProviderInfo | null;
  /** `normalizeGitRemoteUrl`, in the spelling the remote's host uses on the web. */
  readonly repositoryKeyFromRemote: (remoteUrl: string) => string;
  readonly canonicalRepositoryKey: (key: string) => string;
  /** The host that has more than one spelling of `key`, if any does. */
  readonly findByRepositoryKey: (key: string) => SourceControlClientDefinition | undefined;
  readonly repositorySelector: (
    identity: RepositorySelectorIdentity | null | undefined,
  ) => string | null;
  readonly changeRequestHost: <const Kind extends string | undefined>(
    identity: ChangeRequestHostIdentity,
    kind: Kind,
  ) => string | Kind;
  /** The first host, in registry order, that keeps `url` behind a credential. */
  readonly mediaUrl: (url: string) => SourceControlMedia | null;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function inOrder(
  definitions: ReadonlyArray<SourceControlClientDefinition>,
  firstKinds: ReadonlyArray<SourceControlProviderKind> | undefined,
): ReadonlyArray<SourceControlClientDefinition> {
  const first = (firstKinds ?? []).flatMap(
    (kind) => definitions.find((definition) => definition.kind === kind) ?? [],
  );
  return [...first, ...definitions.filter((definition) => !first.includes(definition))];
}

/**
 * `definitions` is display order, and its first entry is what `get` returns for a repository
 * that has not reported its host yet. A change request URL goes to the first definition that
 * reads it, trying `claimChangeRequestUrlsFirst` before the rest, so a host that claims a route
 * only on its own hostnames can precede one that claims the route everywhere. A remote likewise
 * goes to the first that recognises it, in `recognizeRemotesIn` order and then the rest, because
 * one hostname can carry several hosts' labels.
 */
export function makeSourceControlClientRegistry(
  definitions: ReadonlyArray<SourceControlClientDefinition>,
  options?: {
    readonly claimChangeRequestUrlsFirst?: ReadonlyArray<SourceControlProviderKind>;
    readonly recognizeRemotesIn?: ReadonlyArray<SourceControlProviderKind>;
  },
): SourceControlClientRegistry {
  const byKind = new Map<string, SourceControlClientDefinition>();
  for (const definition of definitions) {
    if (byKind.has(definition.kind)) {
      throw new Error(`Source control host '${definition.kind}' is defined more than once.`);
    }
    byKind.set(definition.kind, definition);
  }
  const claimOrder = inOrder(definitions, options?.claimChangeRequestUrlsFirst);
  const recognitionOrder = inOrder(definitions, options?.recognizeRemotesIn);
  const repositoryKeyOwner = (key: string) => {
    for (const definition of definitions) {
      const canonical = definition.canonicalRepositoryKey?.(key);
      if (canonical != null) return { definition, canonical };
    }
    return undefined;
  };
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
    findByPublicDomain: (hostname) => {
      const host = hostname.toLowerCase();
      return definitions.find(
        (definition) =>
          definition.publicHost !== null &&
          (host === definition.publicHost || host.endsWith(`.${definition.publicHost}`)),
      );
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
    recognizeRemote: (remoteUrl) => {
      const remote = parseGitRemoteHost(remoteUrl);
      if (remote === null) return null;
      for (const definition of recognitionOrder) {
        const provider = definition.recognizeRemote(remote);
        if (provider !== null) return provider;
      }
      return unknownRemoteProvider(remote);
    },
    repositoryKeyFromRemote: (remoteUrl) => {
      const key = normalizeGitRemoteUrl(remoteUrl);
      if (parseGitRemoteRepository(remoteUrl) === null) return key;
      for (const definition of definitions) {
        const spelled = definition.repositoryKeyFromRemote?.(key);
        if (spelled != null) return spelled;
      }
      return key;
    },
    canonicalRepositoryKey: (key) => repositoryKeyOwner(key)?.canonical ?? key,
    findByRepositoryKey: (key) => repositoryKeyOwner(key)?.definition,
    repositorySelector: (identity) =>
      identity?.provider === undefined
        ? defaultRepositorySelector(identity)
        : (byKind.get(identity.provider)?.repositorySelector ?? defaultRepositorySelector)(
            identity,
          ),
    changeRequestHost: (identity, kind) =>
      (kind === undefined ? undefined : byKind.get(kind)?.changeRequestHost?.(identity)) ??
      projectChangeRequestHost(identity, kind),
    mediaUrl: (value) => {
      const url = httpUrl(value);
      if (url === null) return null;
      for (const definition of definitions) {
        const media = definition.mediaUrl?.(url);
        if (media != null) return { ...media, definition };
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
