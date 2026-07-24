import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderError,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlIssue,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@t3tools/contracts";

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
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

export function normalizeSourceBranch(headSelector: string): string {
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

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  {
    readonly kind: SourceControlProviderKind;
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
    readonly getIssue?: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<SourceControlIssue, SourceControlProviderError>;
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
>()("t3/sourceControl/SourceControlProvider") {}
