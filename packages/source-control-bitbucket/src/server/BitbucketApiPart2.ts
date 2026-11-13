import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  settingsSecretLiteral,
  TrimmedNonEmptyString,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import { BitbucketPullRequestSchema } from "./bitbucketPullRequests.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as BitbucketClient from "../shared/definition.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

const DEFAULT_API_BASE_URL = "https://api.bitbucket.org/2.0";

export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const MAX_REDIRECTS = 3;

export const BITBUCKET_API_REQUEST_TIMEOUT = "30 seconds";

/** A sweep over many branches would otherwise reach Bitbucket as one burst of lookups. */
export const CONCURRENCY = 4;

export const BitbucketApiEnvConfig = Config.all({
  baseUrl: Config.String("T3CODE_BITBUCKET_API_BASE_URL").pipe(
    Config.withDefault(DEFAULT_API_BASE_URL),
  ),
  accessToken: Config.String("T3CODE_BITBUCKET_ACCESS_TOKEN").pipe(Config.option),
  email: Config.String("T3CODE_BITBUCKET_EMAIL").pipe(Config.option),
  apiToken: Config.String("T3CODE_BITBUCKET_API_TOKEN").pipe(Config.option),
});

// Server and Data Center use a different API; a custom Cloud endpoint must be explicit.
export const BitbucketServesHost = Config.String("T3CODE_BITBUCKET_API_BASE_URL").pipe(
  Config.option,
  Config.map(
    (baseUrl) => (host: string) =>
      Option.isSome(baseUrl) || host === "bitbucket.org" || host.endsWith(".bitbucket.org"),
  ),
);

export const BitbucketApiOperation = Schema.Literals([
  "resolveRepository",
  "getRepository",
  "getBranchingModel",
  "getPullRequest",
  "listPullRequests",
  "createRepository",
  "createPullRequest",
  "probeAuth",
  "checkoutPullRequest",
  "request",
]);
export type BitbucketApiOperation = typeof BitbucketApiOperation.Type;

export class BitbucketRepositoryLocatorError extends Schema.TaggedError<BitbucketRepositoryLocatorError>()(
  "BitbucketRepositoryLocatorError",
  {
    repository: Schema.String,
  },
) {
  static readonly detail = "Bitbucket repositories must be specified as workspace/repository.";

  get detail(): string {
    return BitbucketRepositoryLocatorError.detail;
  }

  get userFacingDetail(): string {
    return BitbucketRepositoryLocatorError.detail;
  }

  override get message(): string {
    return `Bitbucket API failed: ${this.detail}`;
  }
}

export class BitbucketRequestError extends Schema.TaggedError<BitbucketRequestError>()(
  "BitbucketRequestError",
  {
    operation: BitbucketApiOperation,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to send the Bitbucket request.";
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketResponseError extends Schema.TaggedError<BitbucketResponseError>()(
  "BitbucketResponseError",
  {
    operation: BitbucketApiOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
    retryAt: Schema.optional(Schema.Number),
  },
) {
  get detail(): string {
    return `Bitbucket returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketResponseBodyReadError extends Schema.TaggedError<BitbucketResponseBodyReadError>()(
  "BitbucketResponseBodyReadError",
  {
    operation: BitbucketApiOperation,
    status: Schema.Int,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketResponseDecodeError extends Schema.TaggedError<BitbucketResponseDecodeError>()(
  "BitbucketResponseDecodeError",
  {
    operation: BitbucketApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Bitbucket returned invalid JSON for the requested resource.";
  }

  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketRepositoryVcsResolveError extends Schema.TaggedError<BitbucketRepositoryVcsResolveError>()(
  "BitbucketRepositoryVcsResolveError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to resolve VCS repository for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketRepositoryRemotesListError extends Schema.TaggedError<BitbucketRepositoryRemotesListError>()(
  "BitbucketRepositoryRemotesListError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to list remotes for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketRepositoryRemoteNotFoundError extends Schema.TaggedError<BitbucketRepositoryRemoteNotFoundError>()(
  "BitbucketRepositoryRemoteNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return `No Bitbucket repository remote was detected for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketPullRequestBodyReadError extends Schema.TaggedError<BitbucketPullRequestBodyReadError>()(
  "BitbucketPullRequestBodyReadError",
  {
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to read pull request body file ${this.bodyFile}.`;
  }

  override get message(): string {
    return `Bitbucket API failed in createPullRequest: ${this.detail}`;
  }
}

export class BitbucketCheckoutError extends Schema.TaggedError<BitbucketCheckoutError>()(
  "BitbucketCheckoutError",
  {
    cwd: Schema.String,
    reference: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to check out the Bitbucket pull request.";
  }

  override get message(): string {
    return `Bitbucket API failed in checkoutPullRequest: ${this.detail}`;
  }
}

/** Reject response-supplied URLs that could leak credentials. */
export class BitbucketUntrustedUrlError extends Schema.TaggedError<BitbucketUntrustedUrlError>()(
  "BitbucketUntrustedUrlError",
  {
    /** Host only; signed URL queries can contain credentials. */
    host: Schema.String,
  },
) {
  get detail(): string {
    return `The response pointed at ${this.host}, outside the configured Bitbucket.`;
  }

  override get message(): string {
    return `Bitbucket API failed in request: ${this.detail}`;
  }
}

export const BitbucketApiError = Schema.Union([
  BitbucketUntrustedUrlError,
  BitbucketRepositoryLocatorError,
  BitbucketRequestError,
  BitbucketResponseError,
  BitbucketResponseBodyReadError,
  BitbucketResponseDecodeError,
  BitbucketRepositoryVcsResolveError,
  BitbucketRepositoryRemotesListError,
  BitbucketRepositoryRemoteNotFoundError,
  BitbucketPullRequestBodyReadError,
  BitbucketCheckoutError,
  SourceControlRateLimit.SourceControlRateLimitPausedError,
]);
export type BitbucketApiError = typeof BitbucketApiError.Type;

export const isBitbucketApiError = Schema.is(BitbucketApiError);

export const RawBitbucketRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  links: Schema.Struct({
    html: Schema.optional(
      Schema.Struct({
        href: TrimmedNonEmptyString,
      }),
    ),
    clone: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
  }),
  mainbranch: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: TrimmedNonEmptyString,
      }),
    ),
  ),
});

export const RawBitbucketBranchingModelSchema = Schema.Struct({
  development: Schema.optional(
    Schema.Struct({
      branch: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            name: Schema.optional(TrimmedNonEmptyString),
          }),
        ),
      ),
      is_valid: Schema.optional(Schema.Boolean),
      name: Schema.optional(Schema.NullOr(Schema.String)),
      use_mainbranch: Schema.optional(Schema.Boolean),
    }),
  ),
});

export const BitbucketUserSchema = Schema.Struct({
  username: Schema.optional(TrimmedNonEmptyString),
  display_name: Schema.optional(TrimmedNonEmptyString),
  account_id: Schema.optional(TrimmedNonEmptyString),
});

export interface BitbucketRepositoryLocator {
  readonly workspace: string;
  readonly repoSlug: string;
}

export function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

export function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pull-requests|pullrequests|pull-request|pull|pr)\/(\d+)(?:\D.*)?$/i.exec(
    trimmed,
  );
  return urlMatch?.[1] ?? trimmed;
}

export function sourceWorkspace(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

export function toBitbucketStates(state: "open" | "closed" | "merged" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "closed":
      return ["DECLINED", "SUPERSEDED"];
    case "merged":
      return ["MERGED"];
    case "all":
      return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
  }
}

export function bitbucketQueryString(filters: ReadonlyArray<string>): string {
  return filters.join(" AND ");
}

export function bitbucketStateFilter(states: ReadonlyArray<string>): string {
  return states.length === 1
    ? `state = "${states[0]}"`
    : `(${states.map((state) => `state = "${state}"`).join(" OR ")})`;
}

function parseBitbucketRepositorySlug(value: string): BitbucketRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const workspace = parts.at(-2);
  const repoSlug = parts.at(-1);
  return workspace && repoSlug ? { workspace, repoSlug } : null;
}

export function requireRepositoryLocator(
  repository: string,
): Effect.Effect<BitbucketRepositoryLocator, BitbucketApiError> {
  const locator = parseBitbucketRepositorySlug(repository);
  return locator
    ? Effect.succeed(locator)
    : Effect.fail(
        new BitbucketRepositoryLocatorError({
          repository,
        }),
      );
}

export function parseBitbucketRemoteUrl(remoteUrl: string): BitbucketRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  const scpMatch = /^[a-zA-Z0-9._-]+@[^:/]+:(.+)$/.exec(trimmed);
  if (scpMatch?.[1]) {
    return parseBitbucketRepositorySlug(scpMatch[1]);
  }

  try {
    return parseBitbucketRepositorySlug(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

export function normalizeRepositoryCloneUrls(
  raw: typeof RawBitbucketRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  const httpClone =
    raw.links.clone?.find((entry) => entry.name.toLowerCase() === "https")?.href ??
    raw.links.html?.href;
  const sshClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "ssh")?.href;

  return {
    nameWithOwner: raw.full_name,
    url: httpClone ?? raw.links.html?.href ?? raw.full_name,
    sshUrl: sshClone ?? httpClone ?? raw.full_name,
  };
}

export function defaultChangeRequestTargetBranch(input: {
  readonly repository: typeof RawBitbucketRepositorySchema.Type;
  readonly branchingModel: typeof RawBitbucketBranchingModelSchema.Type | null;
}): string | null {
  const repositoryMainBranch = input.repository.mainbranch?.name ?? null;
  const development = input.branchingModel?.development;
  if (!development || development.use_mainbranch === true || development.is_valid === false) {
    return repositoryMainBranch;
  }

  const developmentBranch = development.branch?.name?.trim() ?? development.name?.trim() ?? "";
  if (developmentBranch.length === 0 || developmentBranch === "null") {
    return repositoryMainBranch;
  }

  return developmentBranch;
}

function shouldPreferSshRemote(originRemoteUrl: string | null): boolean {
  if (!originRemoteUrl) return false;
  return isSshRemoteUrl(originRemoteUrl);
}

export function selectCloneUrl(input: {
  readonly cloneUrls: SourceControlRepositoryCloneUrls;
  readonly originRemoteUrl: string | null;
}): string {
  return shouldPreferSshRemote(input.originRemoteUrl)
    ? input.cloneUrls.sshUrl
    : input.cloneUrls.url;
}

export function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  if (!input.isCrossRepository) {
    return input.headBranch;
  }

  return `t3code/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`;
}

export function repositoryNameWithOwner(
  repository: Schema.Schema.Type<typeof BitbucketPullRequestSchema>["source"]["repository"],
): string | null {
  const fullName = repository?.full_name?.trim() ?? "";
  return fullName.length > 0 ? fullName : null;
}

export function repositoryOwnerName(repositoryName: string): string {
  return repositoryName.split("/")[0]?.trim() || "bitbucket";
}

type BitbucketCredential =
  | { readonly kind: "access-token"; readonly accessToken: string }
  | { readonly kind: "api-token"; readonly email: string; readonly apiToken: string };

/** Invalid header values can throw errors containing credentials; treat them as unset. */
const HEADER_SAFE = /^[\x21-\x7e]+$/u;

function credentialFrom(input: {
  readonly accessToken: string;
  readonly email: string;
  readonly apiToken: string;
}): BitbucketCredential | null {
  if (HEADER_SAFE.test(input.accessToken)) {
    return { kind: "access-token", accessToken: input.accessToken };
  }
  if (HEADER_SAFE.test(input.email) && HEADER_SAFE.test(input.apiToken)) {
    return { kind: "api-token", email: input.email, apiToken: input.apiToken };
  }
  return null;
}

export function resolveCredential(
  settings: BitbucketClient.BitbucketSettings,
  env: Config.Success<typeof BitbucketApiEnvConfig>,
): BitbucketCredential | null {
  return (
    credentialFrom({
      accessToken: settingsSecretLiteral(settings.accessToken),
      email: settings.email,
      apiToken: settingsSecretLiteral(settings.apiToken),
    }) ??
    credentialFrom({
      accessToken: Option.getOrElse(env.accessToken, () => ""),
      email: Option.getOrElse(env.email, () => ""),
      apiToken: Option.getOrElse(env.apiToken, () => ""),
    })
  );
}

export function authFromCredential(credential: BitbucketCredential | null): SourceControlProviderAuth {
  if (credential?.kind === "access-token") {
    return {
      status: "unknown",
      account: Option.none(),
      host: Option.some("bitbucket.org"),
      detail: Option.some("An access token is configured."),
    };
  }

  if (credential?.kind === "api-token") {
    return {
      status: "unknown",
      account: Option.some(credential.email),
      host: Option.some("bitbucket.org"),
      detail: Option.some("An API token is configured."),
    };
  }

  return {
    status: "unauthenticated",
    account: Option.none(),
    host: Option.some("bitbucket.org"),
    detail: Option.some(
      "Add a Bitbucket token in Settings → Source Control, or set the T3CODE_BITBUCKET_* environment variables on the server.",
    ),
  };
}

export function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
