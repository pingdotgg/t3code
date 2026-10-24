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
  readonly requestedHost?: string;
}

export interface SourceControlRefSelector {
  readonly refName: string;
  readonly owner?: string;
  readonly repository?: string;
}

const MAX_ERROR_TRANSPORT_VALUE_LENGTH = 256;

/**
 * The fixed product text a provider failure carries for the user, if it has one. Any other
 * detail may be upstream response text, so callers show a generic message instead.
 */
export function userFacingSourceControlDetail(cause: unknown): string | undefined {
  return typeof cause === "object" &&
    cause !== null &&
    "userFacingDetail" in cause &&
    typeof cause.userFacingDetail === "string"
    ? cause.userFacingDetail
    : undefined;
}

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
  } catch {}

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
     * The caller checks the owner against what comes back, so a host that cannot search
     * `owner:branch` can drop those selectors without losing anything.
     */
    readonly headBranchProbe?: (input: {
      readonly headSelectors: ReadonlyArray<string>;
      readonly state: "open" | "all";
    }) => { readonly headSelectors: ReadonlyArray<string>; readonly limit: number };
    readonly readChangeRequestTemplate?: (input: {
      readonly cwd: string;
      readonly treeish: string;
    }) => Effect.Effect<Option.Option<string>>;
    /**
     * The repository's `owner/name` from a remote URL, for a host whose remote paths can carry
     * more than that (Forgejo's HTTP installation mount). Absent means the whole path.
     */
    readonly repositoryNameFromRemoteUrl?: (url: string) => string | null;
    readonly refineRepositoryIdentity?: (input: {
      readonly identity: RepositoryIdentity;
      readonly resolveContext: (input: {
        readonly cwd: string;
        readonly context: SourceControlProviderContext;
      }) => Effect.Effect<SourceControlProviderContext | null, SourceControlProviderError>;
    }) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
    /**
     * The web host serving a remote, for a host whose remote URL may not name it (an SSH alias
     * for one of several servers). It answers for the context's `requestedHost` when the caller
     * narrows to one. Absent, or null, means the remote's own host is the web host.
     */
    readonly resolveRemoteWebHost?: (input: {
      readonly cwd: string;
      readonly context: SourceControlProviderContext;
      readonly resolveContext: (input: {
        readonly cwd: string;
        readonly context: SourceControlProviderContext;
      }) => Effect.Effect<SourceControlProviderContext | null, SourceControlProviderError>;
    }) => Effect.Effect<string | null, SourceControlProviderError>;
    readonly resolveLink?: ResolveSourceControlLink;
    /**
     * Whether `createChangeRequest` from `cwd` targets `repository`, the `owner/name` of the
     * context's remote, for a host whose tools let configuration outside the remotes name another
     * repository. Absent means it does.
     */
    readonly createsChangeRequestsIn?: (input: {
      readonly cwd: string;
      readonly context: SourceControlProviderContext;
      readonly repository: string | null;
    }) => Effect.Effect<boolean>;
    /**
     * Told when T3 records `baseBranch`, a branch name on the host, as the base `branch` was cut
     * from, for a host whose own tools keep that in git config of their own.
     */
    readonly recordBranchBase?: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly baseBranch: string;
    }) => Effect.Effect<void>;
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
