import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import { SourceControlProviderError } from "@t3tools/contracts";

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
const EMBEDDED_HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>`]+/giu;
const EMBEDDED_HTTP_AUTHORITY_CREDENTIALS_PATTERN = /^(https?:\/\/)[^/?#@]*@/iu;

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
  const normalized = printable
    .replace(EMBEDDED_HTTP_URL_PATTERN, transportSafeEmbeddedUrl)
    .trim()
    .replace(/\s+/gu, " ");

  let safe = normalized;
  const parsedUrl = transportSafeUrl(normalized);
  safe = parsedUrl ?? normalized;

  return safe.slice(0, MAX_ERROR_TRANSPORT_VALUE_LENGTH);
}

function transportSafeEmbeddedUrl(value: string): string {
  return (
    transportSafeUrl(value) ?? value.replace(EMBEDDED_HTTP_AUTHORITY_CREDENTIALS_PATTERN, "$1")
  );
}

function transportSafeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
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

export interface SourceControlProviderCommandError {
  readonly command?: string;
  readonly detail?: string;
  readonly message?: string;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function normalizedSourceControlProviderCause(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return {
      message: transportSafeSourceControlErrorValue(String(error)),
    };
  }

  return {
    ...safeErrorField(error, "_tag"),
    ...safeErrorField(error, "name"),
    ...safeErrorField(error, "command"),
    ...safeErrorField(error, "operation"),
    ...safeErrorField(error, "reference"),
    ...safeErrorField(error, "repository"),
    ...safeErrorField(error, "detail"),
    ...safeErrorField(error, "message"),
  };
}

function safeErrorField(error: unknown, key: string): Record<string, string> {
  const value = readStringField(error, key);
  return value === undefined ? {} : { [key]: transportSafeSourceControlErrorValue(value) };
}

export function sourceControlProviderError(input: {
  readonly provider: SourceControlProviderKind;
  readonly operation: string;
  readonly cwd: string;
  readonly error: unknown;
  readonly detail?: string;
  readonly reference?: string;
  readonly repository?: string;
}): SourceControlProviderError {
  const command = readStringField(input.error, "command");
  const detail =
    readStringField(input.error, "detail") ??
    input.detail ??
    readStringField(input.error, "message") ??
    "Source control provider operation failed.";

  return new SourceControlProviderError({
    provider: input.provider,
    operation: input.operation,
    ...(command !== undefined ? { command: transportSafeSourceControlErrorValue(command) } : {}),
    cwd: input.cwd,
    ...(input.reference !== undefined
      ? { reference: transportSafeSourceControlErrorValue(input.reference) }
      : {}),
    ...(input.repository !== undefined
      ? { repository: transportSafeSourceControlErrorValue(input.repository) }
      : {}),
    detail: transportSafeSourceControlErrorValue(detail),
    cause: normalizedSourceControlProviderCause(input.error),
  });
}

export function repositoryPathFromRemoteUrl(remoteUrl: string): string | null {
  const withoutSuffix = (value: string) => value.replace(/\.git$/u, "");
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);
    const path = withoutSuffix(decodeURIComponent(url.pathname).replace(/^\/+/u, "").trim());
    return path.length > 0 ? path : null;
  } catch {
    const scpLike = /^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/u.exec(trimmed);
    if (scpLike?.[1]) {
      const path = withoutSuffix(scpLike[1].replace(/^\/+/u, "").trim());
      return path.length > 0 ? path : null;
    }
    return null;
  }
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
