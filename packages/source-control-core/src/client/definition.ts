/**
 * The client half of a source control host package.
 *
 * Every host package exports a `SourceControlClientDefinition` from its `./client/definition`
 * entry point, the way `./server/driver` is its server entry. Web, mobile, and client-runtime
 * read labels, change request nouns, picker copy, and checkout commands from these definitions,
 * so a new host needs no per-kind branches in client code.
 *
 * Definitions are browser- and React Native-safe: plain data and pure functions, no server or
 * platform UI imports.
 *
 * @module source-control-core/client/definition
 */
import { type PullRequestReviewVerdict, SourceControlProviderKind } from "@t3tools/contracts";

/** What a host calls a change request, e.g. `MR` and `merge request` on GitLab. */
export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

/** Where a project's repository lives, for building its change request URLs. */
export interface ChangeRequestUrlInput {
  /** The host below which the repository is addressed, as `pullRequestHostOf` reports it. */
  readonly host: string;
  /** The repository path below the host. */
  readonly repository: string;
  readonly number: number;
  /** The checkout's remote URL, whose origin some hosts serve their web pages from. */
  readonly remoteUrl?: string | undefined;
  /** The repository's browser URL, when the server resolved one from a hosting account. */
  readonly webUrl?: string | undefined;
}

/** The change request a checkout command is built for. */
export interface ChangeRequestCheckoutInput {
  readonly number: number;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null | undefined;
  /** The repository's web URL, for hosts whose checkout fetches from it. */
  readonly repositoryUrl?: string | null | undefined;
}

export interface SourceControlClientDefinition {
  readonly kind: SourceControlProviderKind;
  /** The host's name, as in "Open on GitHub". */
  readonly label: string;
  /** How the clone and publish pickers name the host; Forgejo's covers Gitea too. */
  readonly pickerLabel: string;
  /** Glyph key each client maps to its own icon; a key a client lacks draws the generic glyph. */
  readonly icon: string;
  readonly changeRequest: ChangeRequestTerminology;
  /** Placeholder for a repository path on this host, such as `owner/repo`. */
  readonly repositoryPathHint: string;
  /**
   * The hostname a change request reference can be attributed to before any repository
   * identity is known, or null when a hostname alone does not name this host.
   */
  readonly publicHost: string | null;
  /** Subtitle beside the host in the publish picker. */
  readonly publishDescription: string;
  /** Where a publish lands, given the host the server is signed in to, if it reported one. */
  readonly publishHost: (signedInHost: string | null) => string;
  /** Which of a repository's clone URLs a new clone uses. */
  readonly defaultCloneTransport: "https" | "ssh";
  /** The web URL of a change request, or null when this client cannot build one for the host. */
  readonly changeRequestUrl: (input: ChangeRequestUrlInput) => string | null;
  /** A shell command that checks the change request out, or null when it cannot be built. */
  readonly checkoutCommand: (changeRequest: ChangeRequestCheckoutInput) => string | null;
  /** A comment author's profile page, or null where the host has none clients can link. */
  readonly authorProfileUrl: (login: string, repositoryUrl: string) => string | null;
  /**
   * The repository URL that `#123` and commit SHAs in change request text link under, using
   * GitHub's `/issues/` and `/commit/` routes, or null where the host does not route them so.
   */
  readonly referenceAutolinkRepositoryUrl: (repositoryUrl: string) => string | null;
  /** Whether a review with this verdict must carry a summary, beyond what every host asks. */
  readonly reviewSummaryRequired: (verdict: PullRequestReviewVerdict) => boolean;
  /** Whether a change request URL has this host's path shape, e.g. GitLab's `/-/merge_requests/`. */
  readonly isChangeRequestUrl: (url: string) => boolean;
}

/**
 * Whether a URL's path is a change request at `route`, such as `/pull/`, followed by its number.
 * Matching the parsed path keeps a query or fragment that mentions another host's route out.
 */
export function isChangeRequestPath(url: string, route: string): boolean {
  try {
    const path = new URL(url).pathname;
    const at = path.indexOf(route);
    return at > 0 && /^\d+(?:\/|$)/u.test(path.slice(at + route.length));
  } catch {
    return false;
  }
}

export function defineSourceControlClient<const Definition extends SourceControlClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

/** What clients show for a host they ship no definition for, including `unknown`. */
const UNKNOWN_SOURCE_CONTROL_CLIENT: SourceControlClientDefinition = {
  kind: SourceControlProviderKind.make("unknown"),
  label: "source control",
  pickerLabel: "source control",
  icon: "change-request",
  changeRequest: { shortLabel: "change request", singular: "change request" },
  repositoryPathHint: "URL",
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  defaultCloneTransport: "ssh",
  changeRequestUrl: () => null,
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  isChangeRequestUrl: () => false,
};

/** The host definitions a client loaded. */
export interface SourceControlClientRegistry {
  readonly definitions: ReadonlyArray<SourceControlClientDefinition>;
  /**
   * The definition for a kind. No kind at all, before a repository reports its host, reads as
   * the first definition; a kind this client lacks, `unknown` included, reads as
   * `UNKNOWN_SOURCE_CONTROL_CLIENT`.
   */
  readonly get: (kind: string | null | undefined) => SourceControlClientDefinition;
  /** The definition for a kind, or `undefined` for one this client lacks. */
  readonly find: (kind: string) => SourceControlClientDefinition | undefined;
  /** The definition whose public instance is `hostname`, if any. */
  readonly findByPublicHost: (hostname: string) => SourceControlClientDefinition | undefined;
  /** The definition whose change request path shape `url` has, if any. */
  readonly findByChangeRequestUrl: (url: string) => SourceControlClientDefinition | undefined;
  /** The name of the host a change request URL is on, for copy about that change request. */
  readonly hostLabelForChangeRequestUrl: (url: string) => string;
}

export function makeSourceControlClientRegistry(
  definitions: ReadonlyArray<SourceControlClientDefinition>,
): SourceControlClientRegistry {
  const byKind = new Map<string, SourceControlClientDefinition>();
  for (const definition of definitions) {
    if (byKind.has(definition.kind)) {
      throw new Error(`Source control host '${definition.kind}' is defined more than once.`);
    }
    byKind.set(definition.kind, definition);
  }
  return {
    definitions,
    get: (kind) =>
      (kind == null ? definitions[0] : byKind.get(kind)) ?? UNKNOWN_SOURCE_CONTROL_CLIENT,
    find: (kind) => byKind.get(kind),
    findByPublicHost: (hostname) => {
      const host = hostname.toLowerCase();
      return definitions.find((definition) => definition.publicHost === host);
    },
    findByChangeRequestUrl: (url) =>
      definitions.find((definition) => definition.isChangeRequestUrl(url)),
    hostLabelForChangeRequestUrl: (url) =>
      definitions.find((definition) => definition.isChangeRequestUrl(url))?.label ?? "the host",
  };
}
