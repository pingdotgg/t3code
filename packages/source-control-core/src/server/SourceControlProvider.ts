import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type {
  RepositoryIdentity,
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderError,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@t3tools/contracts";

export interface SourceControlLinkSubject {
  readonly title: string;
  readonly body: string | null;
}

/** Return undefined synchronously for unsupported URLs, without starting a lookup. */
export type ResolveSourceControlLink = (input: {
  readonly cwd: string;
  readonly url: URL;
}) => Effect.Effect<SourceControlLinkSubject, SourceControlProviderError> | undefined;

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
  /** An explicit web authority can disambiguate Forgejo logins sharing an SSH alias. */
  readonly requestedHost?: string;
}

export interface SourceControlRefSelector {
  readonly refName: string;
  readonly owner?: string;
  readonly repository?: string;
}

const MAX_ERROR_TRANSPORT_VALUE_LENGTH = 256;

/**
 * Sanitizes user-provided source-control identifiers before attaching them to
 * contract errors. This is intentionally narrower than request validation: it
 * only strips URL secrets and bounds diagnostic values sent over transport.
 */
export function transportSafeSourceControlErrorValue(value: string): string {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    printable += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
  }
  const normalized = printable.trim().replace(/\s+/gu, " ");

  let safe = normalized;
  try {
    const url = new URL(normalized);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    safe = url.toString();
  } catch {
    // Plain repository and change-request identifiers are not URLs.
  }

  return safe.slice(0, MAX_ERROR_TRANSPORT_VALUE_LENGTH);
}

export function parseSourceControlOwnerRef(
  headSelector: string,
): SourceControlRefSelector | undefined {
  const match = /^([^:/\s]+):(.+)$/u.exec(headSelector.trim());
  const owner = match?.[1]?.trim();
  const refName = match?.[2]?.trim();
  return owner && refName ? { owner, refName } : undefined;
}

function normalizeSourceBranch(headSelector: string): string {
  return parseSourceControlOwnerRef(headSelector)?.refName ?? headSelector.trim();
}

export function sourceBranch(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeSourceBranch(input.headSelector);
}

export function sourceControlRefFromInput(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): SourceControlRefSelector | undefined {
  return input.source ?? parseSourceControlOwnerRef(input.headSelector);
}

/** The repository path a remote URL names (`owner/name`, or deeper for nested groups). */
export function repositoryPathFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:[^@/\s]+@[^:/\s]+:|(?:ssh|https?|git):\/\/[^/]+\/)((?:[^/\s]+\/)+[^/\s]+?)(?:\.git)?\/?$/iu.exec(
      trimmed,
    );
  const path = match?.[1]?.trim() ?? "";
  return path.length > 0 ? path : null;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  {
    readonly kind: SourceControlProviderKind;
    /**
     * How to look up a branch's change requests: which head selectors to ask about, and how many
     * results to read per selector. The caller checks the owner against what comes back, so a
     * host that cannot search `owner:branch` can drop those selectors without losing anything.
     * Absent asks about every selector, reading 1 for the open lookup and 20 for any state.
     */
    readonly headBranchProbe?: (input: {
      readonly headSelectors: ReadonlyArray<string>;
      readonly state: "open" | "all";
    }) => { readonly headSelectors: ReadonlyArray<string>; readonly limit: number };
    /**
     * The repository's change request template at `treeish`, for change request content
     * generation to follow. Absent means the host has no template convention.
     */
    readonly readChangeRequestTemplate?: (input: {
      readonly cwd: string;
      readonly treeish: string;
    }) => Effect.Effect<Option.Option<string>>;
    /**
     * The repository's `owner/name` from a remote URL, for a host whose remote paths can carry
     * more than that (Forgejo's HTTP installation mount). Absent means the whole path.
     */
    readonly repositoryNameFromRemoteUrl?: (url: string) => string | null;
    /**
     * Fills in what a repository identity read from git cannot know, such as the browser URL of
     * a host the remote URL does not name. `resolveContext` asks the registry which host (and
     * base URL) serves a remote. Only consulted for identities this host may own.
     */
    readonly refineRepositoryIdentity?: (input: {
      readonly identity: RepositoryIdentity;
      readonly resolveContext: (input: {
        readonly cwd: string;
        readonly context: SourceControlProviderContext;
      }) => Effect.Effect<SourceControlProviderContext | null, SourceControlProviderError>;
    }) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
    /** Optional capability for issue and change-request subjects. */
    readonly resolveLink?: ResolveSourceControlLink;
    readonly listChangeRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly source?: SourceControlRefSelector;
      readonly headSelector: string;
      readonly state: ChangeRequestState | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
    readonly getChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<ChangeRequest, SourceControlProviderError>;
    readonly createChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly source?: SourceControlRefSelector;
      readonly target?: SourceControlRefSelector;
      readonly baseRefName: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, SourceControlProviderError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
    }) => Effect.Effect<string | null, SourceControlProviderError>;
    readonly checkoutChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, SourceControlProviderError>;
  }
>()("@t3tools/source-control-core/server/SourceControlProvider") {}
