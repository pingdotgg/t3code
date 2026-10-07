import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, type SourceControlRepositoryVisibility } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  detectSourceControlProviderFromRemoteUrl,
  isSshRemoteUrl,
} from "@t3tools/shared/sourceControl";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import {
  decodeGitHubPullRequestEntries,
  type NormalizedGitHubPullRequestRecord,
} from "./gitHubPullRequests.ts";

export const AllowGitHubReserve = GitHubApi.AllowGitHubReserve;

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedError<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  override get message(): string {
    return "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.";
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedError<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  gitHubCliFailureFields,
) {
  override get message(): string {
    // A missing or turned-off credential already says what to do about it.
    return GitHubCredentials.isGitHubCredentialUnavailableError(this.cause)
      ? this.cause.message
      : "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.";
  }
}

export class GitHubCliRateLimitError extends Schema.TaggedError<GitHubCliRateLimitError>()(
  "GitHubCliRateLimitError",
  { ...gitHubCliFailureFields, retryAt: Schema.optionalKey(Schema.Finite) },
) {
  override get message(): string {
    return "GitHub API rate limit exceeded. Requests resume when the limit resets.";
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedError<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  override get message(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }
}

export class GitHubCliCommandError extends Schema.TaggedError<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  { ...gitHubCliFailureFields, httpStatus: Schema.optional(Schema.Int) },
) {
  override get message(): string {
    // GitHub's own reason ("A pull request already exists…") or the failed step's, when known.
    const reason =
      this.cause instanceof Error && this.cause.message.trim() !== ""
        ? this.cause.message.trim()
        : null;
    return reason === null ? "GitHub request failed." : reason;
  }
}

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedError<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  override get message(): string {
    return "GitHub returned an invalid pull request list.";
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedError<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  override get message(): string {
    return "GitHub returned an invalid change request list.";
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedError<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  override get message(): string {
    return "GitHub returned an invalid pull request.";
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedError<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  override get message(): string {
    return "GitHub returned an invalid repository.";
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubCliRateLimitError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

/** Maps a GitHub API failure onto the errors callers of this service already handle. */
function fromGitHubApiError(cwd: string, error: GitHubApi.GitHubApiError): GitHubCliError {
  const context = { command: "gh" as const, cwd, cause: error };
  switch (error._tag) {
    case "GitHubCliMissingError":
      return new GitHubCliUnavailableError(context);
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubApiAuthenticationError":
      return new GitHubCliAuthenticationError(context);
    case "GitHubCliFailedError":
      return new GitHubCliCommandError(context);
    case "GitHubApiRateLimitError":
      return new GitHubCliRateLimitError({
        ...context,
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      });
    case "SourceControlRateLimitPausedError":
      return new GitHubCliRateLimitError({ ...context, retryAt: error.retryAt });
    case "GitHubApiNotFoundError":
      return new GitHubPullRequestNotFoundError(context);
    case "GitHubApiResponseError":
      return new GitHubCliCommandError({ ...context, httpStatus: error.status });
    case "GitHubApiRequestError":
      return new GitHubCliCommandError(context);
  }
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

function pullRequestSummary(input: NormalizedGitHubPullRequestRecord): GitHubPullRequestSummary {
  const { updatedAt, ...summary } = input;
  return {
    ...summary,
    ...(Option.isSome(updatedAt) ? { updatedAt: DateTime.formatIso(updatedAt.value) } : {}),
  };
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
      readonly rateLimitHost?: string;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    /**
     * Pull requests whose head is `headSelector` (a branch, or `owner:branch` for a fork), in the
     * repository `gh pr list` would read in `cwd`. Lookups on one repository that arrive
     * together share one GraphQL document.
     */
    readonly listPullRequestsByHead: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit: number;
      /** The checkout's GitHub API host. Without it, the host comes from the git remotes. */
      readonly rateLimitHost?: string;
    }) => Effect.Effect<ReadonlyArray<NormalizedGitHubPullRequestRecord>, GitHubCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly rateLimitHost?: string;
    }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly rateLimitHost?: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

/**
 * The repository `gh pr list` reads in a checkout, picked the way gh picks one without a
 * prompt: the remote `gh repo set-default` marked, else the first of upstream, github, origin
 * (in any case), else the only remote. `remotes` is `git remote -v` output and `resolved` is the output of
 * `git config --get-regexp '^remote\..*\.gh-resolved$'`.
 *
 * Null whenever gh might weigh the remotes differently: a remote on another host or under an
 * SSH alias, more than one mark, or several remotes with none of those names. Callers then
 * fall back to the provider's remote, then to the best-ranked remote on the host.
 */
export function selectGitHubBaseRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  readonly host: string;
}): { readonly owner: string; readonly name: string } | null {
  const host = input.host.toLowerCase();
  const repositories = new Map<string, { readonly owner: string; readonly name: string }>();
  for (const line of input.remotes.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
    if (!match) continue;
    const [remoteHost, owner, name, ...rest] = normalizeGitRemoteUrl(match[2]!).split("/");
    if (remoteHost !== host || !owner || !name || rest.length > 0) return null;
    repositories.set(match[1]!, { owner, name });
  }
  const marks = input.resolved
    .split("\n")
    .map((line) => /^remote\.(.+)\.gh-resolved\s+(\S+)$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && repositories.has(match[1]!));
  if (marks.length > 1) return null;
  const [mark] = marks;
  if (mark) {
    if (mark[2] === "base") return repositories.get(mark[1]!) ?? null;
    const [owner, name, ...rest] = mark[2]!.toLowerCase().split("/");
    return owner && name && rest.length === 0 ? { owner, name } : null;
  }
  // gh sorts remotes by these names, case-insensitively, and takes the first. A tie for the
  // top place has no defined winner.
  const score = (remoteName: string) =>
    ["origin", "github", "upstream"].indexOf(remoteName.toLowerCase()) + 1;
  const ranked = [...repositories.entries()].toSorted(
    ([left], [right]) => score(right) - score(left),
  );
  const [top, next] = ranked;
  return top !== undefined && (next === undefined || score(top[0]) > score(next[0]))
    ? top[1]
    : null;
}

const RawRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  ssh_url: TrimmedNonEmptyString,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRawRepository = decodeJsonResult(RawRepositorySchema);

function repositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawRepositorySchema>,
): GitHubRepositoryCloneUrls {
  return { nameWithOwner: raw.full_name, url: raw.html_url, sshUrl: raw.ssh_url };
}

const decodeViewerLogin = decodeJsonResult(Schema.Struct({ login: TrimmedNonEmptyString }));

type PullRequestListState = "open" | "closed" | "merged" | "all";

/** The pull request fields every read selects, in GraphQL. */
const PULL_REQUEST_NODE_SELECTION =
  "number title url baseRefName headRefName state isDraft mergedAt closedAt updatedAt isCrossRepository headRepository { name nameWithOwner } headRepositoryOwner { login }";
const GRAPHQL_STATES: Record<PullRequestListState, ReadonlyArray<string>> = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
};
/**
 * Head lookups per GraphQL document. A document of a hundred costs one point, the same as one
 * single lookup, but half that keeps each answer near half a second.
 */
const HEAD_LOOKUPS_PER_DOCUMENT = 50;
/**
 * How long a head lookup waits for company. Branch discovery reaches GitHub only after each
 * branch's own git reads, so lookups started together arrive tens of milliseconds apart.
 * A background sweep's lookups spread over up to ~300ms, and every document costs a point no
 * matter how few heads it holds, so lookups no user waits on (no reserve) wait longer.
 */
const HEAD_LOOKUP_BATCH_WINDOW = "50 millis";
const BACKGROUND_HEAD_LOOKUP_BATCH_WINDOW = "500 millis";
/** A full document is 5,000 rows of well under 2 KB each. */
const HEAD_LOOKUP_MAX_RESPONSE_BYTES = 16_000_000;
/**
 * Rows read for a fork's `owner:branch` head, which GitHub cannot filter by owner. A branch
 * named like a busy default (`main`) is the case this bounds; the owner's own row is near the
 * top because the newest come first.
 */
const OWNER_HEAD_SCAN_LIMIT = 100;

class PullRequestsByHeadRead extends Request.Class<
  {
    readonly cwd: string;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly headRefName: string;
    readonly state: PullRequestListState;
    readonly limit: number;
    readonly allowReserve: boolean;
  },
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  GitHubCliError
> {}

/** One aliased `pullRequests` connection per lookup, each head and state passed as a variable. */
function buildPullRequestsByHeadQuery(
  lookups: ReadonlyArray<Pick<PullRequestsByHeadRead, "headRefName" | "state" | "limit">>,
): { readonly document: string; readonly variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const declarations: string[] = ["$owner: String!", "$name: String!"];
  const selections: string[] = [];
  for (const [index, lookup] of lookups.entries()) {
    variables[`h${index}`] = lookup.headRefName;
    variables[`s${index}`] = GRAPHQL_STATES[lookup.state];
    declarations.push(`$h${index}: String!`, `$s${index}: [PullRequestState!]`);
    // `gh pr list` orders the same way, so a head with more matches than the limit keeps the
    // same rows.
    selections.push(
      `    h${index}: pullRequests(headRefName: $h${index}, states: $s${index}, first: ${lookup.limit}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PULL_REQUEST_NODE_SELECTION} } }`,
    );
  }
  return {
    document: `query PullRequestsByHead(${declarations.join(", ")}) {\n  repository(owner: $owner, name: $name) {\n${selections.join("\n")}\n  }\n}`,
    variables,
  };
}

const PULL_REQUEST_BY_NUMBER_QUERY = `query PullRequestByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PULL_REQUEST_NODE_SELECTION} }
  }
}`;

const decodePullRequestsByHead = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(
        Schema.Record(
          Schema.String,
          Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })),
        ),
      ),
    }),
  }),
);

const decodePullRequestByNumber = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(Schema.Unknown) })),
    }),
  }),
);

/** A repository on a GitHub host: the API it is read through, and its owner and name. */
export interface GitHubRepositoryLocator {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/** `owner/name` or `host/owner/name`, as `gh --repo` and GH_REPO take them. */
function parseGitHubRepositorySelector(
  selector: string,
  defaultHost: string,
): GitHubRepositoryLocator | null {
  const trimmed = selector.trim().replace(/\.git$/i, "");
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const [owner, name, ...rest] = url.pathname.split("/").filter(Boolean);
      return owner && name && rest.length === 0
        ? { host: url.host.toLowerCase(), owner, name }
        : null;
    } catch {
      return null;
    }
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 2) return { host: defaultHost, owner: parts[0]!, name: parts[1]! };
  if (parts.length === 3)
    return { host: parts[0]!.toLowerCase(), owner: parts[1]!, name: parts[2]! };
  return null;
}

/**
 * A pull request reference the way `gh pr view` takes one: a number (`#7` too), a pull request
 * URL, or a branch name.
 */
function parsePullRequestReference(
  reference: string,
):
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "url"; readonly locator: GitHubRepositoryLocator; readonly number: number }
  | { readonly kind: "branch"; readonly headSelector: string } {
  const trimmed = reference.trim();
  const numbered = /^#?([1-9]\d*)$/.exec(trimmed);
  if (numbered) return { kind: "number", number: Number(numbered[1]) };
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname);
      if (match) {
        return {
          kind: "url",
          locator: { host: url.host.toLowerCase(), owner: match[1]!, name: match[2]! },
          number: Number(match[3]),
        };
      }
    } catch {
      // Not a URL after all; read it as a branch.
    }
  }
  return { kind: "branch", headSelector: trimmed };
}

/**
 * The GitHub host a remote URL is served from, or null for a remote that is not GitHub. An SSH
 * alias (`git@github-work:owner/repo`) names no API host of its own; it is read through
 * `github.com`, which is what such an alias almost always stands for (issue #6198).
 */
export function gitHubApiHostForRemote(remoteUrl: string): string | null {
  const provider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
  if (provider === null) return null;
  const host = new URL(provider.baseUrl).host.toLowerCase();
  // A dotless SSH host is an alias from ~/.ssh/config, never a real API host.
  if (isSshRemoteUrl(remoteUrl) && !host.includes(".")) {
    return host.includes("github") ? "github.com" : null;
  }
  return provider.kind === "github" ? host : null;
}

/** A caller's host hint, read the way a remote's host is: a dotless alias is not an API host. */
function apiHostForHint(host: string): string {
  const normalized = host.toLowerCase();
  return !normalized.includes(".") && normalized.includes("github") ? "github.com" : normalized;
}

/** The local branch a pull request checks out into, the way `gh pr checkout` names it. */
export function pullRequestCheckoutBranchName(input: {
  readonly headRefName: string;
  readonly headOwner: string | null;
  readonly isCrossRepository: boolean;
  readonly defaultBranch: string | null;
}): string {
  // gh prefixes the owner only where the fork's branch would take over the default branch's
  // name, which is the one collision every fork pull request from `main` would hit.
  return input.isCrossRepository &&
    input.headOwner !== null &&
    input.defaultBranch !== null &&
    input.headRefName === input.defaultBranch
    ? `${input.headOwner}/${input.headRefName}`
    : input.headRefName;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const environment = yield* HostProcessEnvironment;
  const api = yield* GitHubApi.GitHubApi;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;

  const gitRead = (cwd: string, args: ReadonlyArray<string>) =>
    process.run({
      operation: "GitHubCli.resolveRepository",
      command: "git",
      args,
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    });

  const commandFailure = (cwd: string, detail: string) =>
    new GitHubCliCommandError({ command: "gh", cwd, cause: new Error(detail) });

  /**
   * The repository `gh` would act on in `cwd`: GH_REPO, else the remote `gh` would pick, else
   * the remote the caller resolved the provider from, else the best-ranked GitHub remote.
   */
  const resolveRepository = Effect.fn("GitHubCli.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
  }) {
    const envRepository = environment.GH_REPO?.trim();
    const defaultHost = (input.host ?? environment.GH_HOST ?? "github.com").toLowerCase();
    if (envRepository) {
      const locator = parseGitHubRepositorySelector(envRepository, defaultHost);
      if (locator !== null) return locator;
    }
    const [remotes, resolved] = yield* Effect.all([
      gitRead(input.cwd, ["remote", "-v"]),
      gitRead(input.cwd, ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]),
    ]).pipe(Effect.orElseSucceed(() => [null, null] as const));
    const remoteOutput = remotes?.exitCode === 0 ? remotes.stdout : "";
    const fetchRemotes = remoteOutput
      .split("\n")
      .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        name: match[1]!,
        url: match[2]!,
        host: gitHubApiHostForRemote(match[2]!),
      }));
    const host =
      (input.host === undefined ? undefined : apiHostForHint(input.host)) ??
      fetchRemotes.find((remote) => remote.name === "origin" && remote.host !== null)?.host ??
      fetchRemotes.find((remote) => remote.host !== null)?.host ??
      defaultHost;
    const selected = selectGitHubBaseRepository({
      remotes: remoteOutput,
      resolved: resolved?.exitCode === 0 ? resolved.stdout : "",
      host,
    });
    if (selected !== null) return { host, ...selected };
    // gh's own order without its prompt: upstream, github, origin, then the first remote, among
    // the ones on this host (an SSH alias counts as its API host).
    const rank = (name: string) => ["upstream", "github", "origin"].indexOf(name.toLowerCase());
    const candidates = fetchRemotes
      .filter((remote) => remote.host === host)
      .toSorted((left, right) => {
        const l = rank(left.name);
        const r = rank(right.name);
        return (l === -1 ? 99 : l) - (r === -1 ? 99 : r);
      });
    for (const remote of candidates) {
      const [owner, name, ...rest] = normalizeGitRemoteUrl(remote.url).split("/").slice(1);
      if (owner && name && rest.length === 0) return { host, owner, name };
    }
    return yield* commandFailure(
      input.cwd,
      `No GitHub repository on ${host} was found among this checkout's git remotes.`,
    );
  });

  const graphqlJson = <A>(
    cwd: string,
    input: GitHubApi.GitHubGraphQlInput,
    decode: (raw: string) => Result.Result<A, unknown>,
    onDecodeFailure: (cause: unknown) => GitHubCliError,
  ) =>
    api.graphql(input).pipe(
      Effect.mapError((error) => fromGitHubApiError(cwd, error)),
      Effect.flatMap((raw) => {
        const decoded = decode(raw);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(onDecodeFailure(decoded.failure));
      }),
    );

  const rest = (cwd: string, input: GitHubApi.GitHubRestInput) =>
    api.rest(input).pipe(Effect.mapError((error) => fromGitHubApiError(cwd, error)));

  /** Pull requests whose head branch is `headRefName` on one repository. */
  const readPullRequestsByHead = (input: {
    readonly cwd: string;
    readonly locator: GitHubRepositoryLocator;
    readonly lookups: ReadonlyArray<
      Pick<PullRequestsByHeadRead, "headRefName" | "state" | "limit">
    >;
    readonly allowReserve: boolean;
    readonly onDecodeFailure: (cause: unknown) => GitHubCliError;
  }) => {
    const query = buildPullRequestsByHeadQuery(input.lookups);
    return graphqlJson(
      input.cwd,
      {
        host: input.locator.host,
        operation: "listPullRequestsByHead",
        query: query.document,
        variables: { owner: input.locator.owner, name: input.locator.name, ...query.variables },
        allowReserve: input.allowReserve,
        // Up to 50 heads of 100 rows each. A default branch such as `main` can match a hundred
        // fork pull requests, so the usual cap would cut the answer short.
        maxResponseBytes: HEAD_LOOKUP_MAX_RESPONSE_BYTES,
      },
      decodePullRequestsByHead,
      input.onDecodeFailure,
    ).pipe(
      Effect.flatMap((decoded) =>
        decoded.data.repository === null
          ? Effect.fail(
              new GitHubPullRequestNotFoundError({
                command: "gh",
                cwd: input.cwd,
                cause: new Error("The repository could not be read."),
              }),
            )
          : Effect.succeed(decoded.data.repository),
      ),
    );
  };

  const headResolver = RequestResolver.makeGrouped<PullRequestsByHeadRead, string>({
    key: ({ request, context }) =>
      [
        request.host,
        request.owner,
        request.name,
        String(request.allowReserve),
        Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null)
          ?.credentialFingerprint ?? "",
        Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
      ].join("\0"),
    resolver: (entries) => {
      const [first] = entries;
      const { cwd, host, owner, name, allowReserve } = first.request;
      return readPullRequestsByHead({
        cwd,
        locator: { host, owner, name },
        lookups: entries.map((entry) => entry.request),
        allowReserve,
        onDecodeFailure: (cause) =>
          new GitHubChangeRequestListDecodeError({ command: "gh", cwd, cause }),
      }).pipe(
        Effect.map((aliases) => {
          for (const [index, entry] of entries.entries()) {
            const alias = aliases[`h${index}`];
            entry.completeUnsafe(
              Exit.succeed(alias == null ? [] : decodeGitHubPullRequestEntries(alias.nodes)),
            );
          }
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(RequestResolver.batchN(HEAD_LOOKUPS_PER_DOCUMENT));
  const interactiveHeadResolver = headResolver.pipe(
    RequestResolver.setDelay(HEAD_LOOKUP_BATCH_WINDOW),
  );
  const backgroundHeadResolver = headResolver.pipe(
    RequestResolver.setDelay(BACKGROUND_HEAD_LOOKUP_BATCH_WINDOW),
  );

  const listByHead = Effect.fn("GitHubCli.listByHead")(function* (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly state: PullRequestListState;
    readonly limit: number;
    readonly rateLimitHost?: string | undefined;
    readonly allowReserve: boolean;
  }) {
    const locator = yield* resolveRepository({ cwd: input.cwd, host: input.rateLimitHost });
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
    // `owner:branch` names a fork's branch. GitHub filters on the branch name only, so the
    // owner is matched on the rows it returns.
    const ownerMatch = /^([^:/\s]+):(.+)$/u.exec(input.headSelector.trim());
    const headRefName = ownerMatch?.[2] ?? input.headSelector.trim();
    const rows = yield* Effect.request(
      new PullRequestsByHeadRead({
        cwd: input.cwd,
        ...locator,
        headRefName,
        state: input.state,
        limit: ownerMatch ? OWNER_HEAD_SCAN_LIMIT : limit,
        allowReserve: input.allowReserve,
      }),
      input.allowReserve ? interactiveHeadResolver : backgroundHeadResolver,
    );
    if (!ownerMatch) return rows;
    const headOwner = ownerMatch[1]!.toLowerCase();
    return rows
      .filter((row) => row.headRepositoryOwnerLogin?.toLowerCase() === headOwner)
      .slice(0, limit);
  });

  const toSummaries = (rows: ReadonlyArray<NormalizedGitHubPullRequestRecord>) =>
    rows.map(pullRequestSummary);

  const readPullRequest = Effect.fn("GitHubCli.readPullRequest")(function* (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly rateLimitHost?: string | undefined;
  }) {
    const parsed = parsePullRequestReference(input.reference);
    if (parsed.kind === "branch") {
      // `gh pr view <branch>` prefers an open pull request, then the newest of any state.
      const [open] = yield* listByHead({
        cwd: input.cwd,
        headSelector: parsed.headSelector,
        state: "open",
        limit: 1,
        rateLimitHost: input.rateLimitHost,
        allowReserve: true,
      });
      const found =
        open ??
        (yield* listByHead({
          cwd: input.cwd,
          headSelector: parsed.headSelector,
          state: "all",
          limit: 1,
          rateLimitHost: input.rateLimitHost,
          allowReserve: true,
        }))[0];
      if (found === undefined) {
        return yield* new GitHubPullRequestNotFoundError({
          command: "gh",
          cwd: input.cwd,
          cause: new Error("No pull request has this head branch."),
        });
      }
      return found;
    }
    const locator =
      parsed.kind === "url"
        ? parsed.locator
        : yield* resolveRepository({ cwd: input.cwd, host: input.rateLimitHost });
    const decodeFailure = (cause: unknown) =>
      new GitHubPullRequestDecodeError({ command: "gh", cwd: input.cwd, cause });
    const decoded = yield* graphqlJson(
      input.cwd,
      {
        host: locator.host,
        operation: "getPullRequest",
        query: PULL_REQUEST_BY_NUMBER_QUERY,
        variables: { owner: locator.owner, name: locator.name, number: parsed.number },
        allowReserve: true,
      },
      decodePullRequestByNumber,
      decodeFailure,
    );
    const node = decoded.data.repository?.pullRequest;
    if (node == null) {
      return yield* new GitHubPullRequestNotFoundError({
        command: "gh",
        cwd: input.cwd,
        cause: new Error("The pull request does not exist."),
      });
    }
    const [record] = decodeGitHubPullRequestEntries([node]);
    if (record === undefined) return yield* decodeFailure(new Error("Malformed pull request."));
    return record;
  });

  const readRepository = Effect.fn("GitHubCli.readRepository")(function* (
    cwd: string,
    locator: GitHubRepositoryLocator,
  ) {
    const response = yield* rest(cwd, {
      host: locator.host,
      operation: "getRepository",
      path: `repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`,
      allowReserve: true,
    });
    const decoded = decodeRawRepository(response.body);
    if (Result.isFailure(decoded)) {
      return yield* new GitHubRepositoryDecodeError({
        command: "gh",
        cwd,
        cause: decoded.failure,
      });
    }
    return decoded.success;
  });

  const readViewerLogin = Effect.fn("GitHubCli.readViewerLogin")(function* (
    cwd: string,
    host: string,
  ) {
    const response = yield* rest(cwd, { host, operation: "getViewer", path: "user" });
    const decoded = decodeViewerLogin(response.body);
    if (Result.isFailure(decoded)) {
      return yield* new GitHubCliCommandError({ command: "gh", cwd, cause: decoded.failure });
    }
    return decoded.success.login;
  });

  const gitFailure = (cwd: string) => (cause: unknown) =>
    new GitHubCliCommandError({ command: "gh", cwd, cause });

  const runGit = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: `GitHubCli.checkoutPullRequest.${operation}`, cwd, args });

  /**
   * `gh pr checkout` in plain git: the head branch is fetched from the remote that holds it (a
   * fork gets a remote of its own), checked out under the name gh would give it, and set to
   * track the head. A head branch that is gone is read from the base's `refs/pull/<n>/head`.
   * An existing branch fast-forwards, or with `force` is reset to the pull request.
   */
  const checkoutPullRequest: GitHubCli["Service"]["checkoutPullRequest"] = Effect.fn(
    "GitHubCli.checkoutPullRequest",
  )(function* (input) {
    const reference = parsePullRequestReference(input.reference);
    const pullRequest = yield* readPullRequest({ cwd: input.cwd, reference: input.reference });
    const base =
      reference.kind === "url" ? reference.locator : yield* resolveRepository({ cwd: input.cwd });
    const baseNameWithOwner = `${base.owner}/${base.name}`.toLowerCase();
    const headNameWithOwner = pullRequest.headRepositoryNameWithOwner ?? null;
    const isCrossRepository =
      pullRequest.isCrossRepository ??
      (headNameWithOwner !== null && headNameWithOwner.toLowerCase() !== baseNameWithOwner);
    const headOwner =
      pullRequest.headRepositoryOwnerLogin ?? headNameWithOwner?.split("/")[0] ?? null;

    const remotes = yield* gitRead(input.cwd, ["remote", "-v"]).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout : "")),
      Effect.mapError(gitFailure(input.cwd)),
    );
    const remoteFor = (nameWithOwner: string) =>
      remotes
        .split("\n")
        .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim()))
        .find(
          (match) =>
            match !== null &&
            normalizeGitRemoteUrl(match[2]!).split("/").slice(1).join("/") ===
              nameWithOwner.toLowerCase(),
        )?.[1] ?? null;
    const baseRemote = Effect.suspend(() => {
      const known = remoteFor(baseNameWithOwner);
      return known === null ? git.resolvePrimaryRemoteName(input.cwd) : Effect.succeed(known);
    });
    // A fork's branch named like the base's default branch is checked out under the owner's
    // prefix. Without the default branch that collision cannot be ruled out, and the checkout
    // would reset the local default branch to the fork's commit, so it fails instead.
    const defaultBranch = isCrossRepository
      ? yield* readRepository(input.cwd, base).pipe(
          Effect.map((repository) => repository.default_branch ?? null),
        )
      : null;
    const localBranch = pullRequestCheckoutBranchName({
      headRefName: pullRequest.headRefName,
      headOwner,
      isCrossRepository,
      defaultBranch,
    });

    /** The remote the head branch lives on; a fork the checkout does not know yet is added. */
    const headRemote = Effect.gen(function* () {
      if (!isCrossRepository) return yield* baseRemote;
      if (headNameWithOwner === null) return yield* commandFailure(input.cwd, "The fork is gone.");
      const known = remoteFor(headNameWithOwner);
      if (known !== null) return known;
      const [owner, name] = headNameWithOwner.split("/");
      const fork = yield* readRepository(input.cwd, {
        host: base.host,
        owner: owner!,
        name: name!,
      });
      const originUrl = yield* git.readConfigValue(input.cwd, "remote.origin.url");
      return yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: headOwner ?? "fork",
        url: originUrl !== null && isSshRemoteUrl(originUrl) ? fork.ssh_url : fork.html_url,
      });
    });

    const exists = (yield* git
      .listLocalBranchNames(input.cwd)
      .pipe(Effect.mapError(gitFailure(input.cwd)))).includes(localBranch);

    // The commit to check out, fetched from the head branch where it still exists.
    const target = yield* Effect.gen(function* () {
      const remoteName = yield* headRemote;
      yield* git.fetchRemoteTrackingBranch({
        cwd: input.cwd,
        remoteName,
        remoteBranch: pullRequest.headRefName,
      });
      return {
        ref: `refs/remotes/${remoteName}/${pullRequest.headRefName}`,
        upstream: { remoteName, remoteBranch: pullRequest.headRefName },
      };
    }).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* runGit(input.cwd, "fetchPullRef", [
            "fetch",
            "--quiet",
            "--no-tags",
            yield* baseRemote,
            `refs/pull/${pullRequest.number}/head`,
          ]);
          const { commitSha } = yield* git.resolveCommit({
            cwd: input.cwd,
            revision: "FETCH_HEAD",
          });
          return { ref: commitSha, upstream: null };
        }),
      ),
      Effect.mapError(gitFailure(input.cwd)),
    );

    yield* Effect.gen(function* () {
      if (!exists) yield* runGit(input.cwd, "branch", ["branch", localBranch, target.ref]);
      yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      if (exists) {
        yield* runGit(
          input.cwd,
          "sync",
          input.force === true
            ? ["reset", "--hard", "--quiet", target.ref]
            : ["merge", "--ff-only", "--quiet", target.ref],
        );
      }
      // Tracking is set once the branch is the pull request's, so a sync that fails leaves an
      // existing branch's upstream as it was.
      if (target.upstream !== null) {
        yield* git.setBranchUpstream({ cwd: input.cwd, branch: localBranch, ...target.upstream });
      }
    }).pipe(Effect.mapError(gitFailure(input.cwd)));
  });

  return GitHubCli.of({
    listPullRequestsByHead: (input) =>
      AllowGitHubReserve.pipe(
        Effect.flatMap((allowReserve) => listByHead({ ...input, allowReserve })),
      ),
    listOpenPullRequests: (input) =>
      listByHead({
        cwd: input.cwd,
        headSelector: input.headSelector,
        state: "open",
        limit: input.limit ?? 1,
        rateLimitHost: input.rateLimitHost,
        allowReserve: true,
      }).pipe(Effect.map(toSummaries)),
    getPullRequest: (input) => readPullRequest(input).pipe(Effect.map(pullRequestSummary)),
    getRepositoryCloneUrls: (input) =>
      Effect.gen(function* () {
        const fallbackHost = (yield* resolveRepository({ cwd: input.cwd }).pipe(
          Effect.map((locator) => locator.host),
          Effect.orElseSucceed(() => environment.GH_HOST ?? "github.com"),
        )).toLowerCase();
        const locator = parseGitHubRepositorySelector(input.repository, fallbackHost);
        if (locator === null) {
          return yield* commandFailure(input.cwd, "Repositories are named owner/name.");
        }
        return repositoryCloneUrls(yield* readRepository(input.cwd, locator));
      }),
    createRepository: (input) =>
      Effect.gen(function* () {
        const locator = parseGitHubRepositorySelector(
          input.repository,
          (environment.GH_HOST ?? "github.com").toLowerCase(),
        );
        const viewer = locator === null ? null : yield* readViewerLogin(input.cwd, locator.host);
        const owner = locator?.owner ?? viewer;
        const name = locator?.name ?? input.repository.trim();
        const host = locator?.host ?? (environment.GH_HOST?.trim().toLowerCase() || "github.com");
        const isViewer = viewer !== null && owner?.toLowerCase() === viewer.toLowerCase();
        const response = yield* rest(input.cwd, {
          host,
          operation: "createRepository",
          method: "POST",
          path:
            isViewer || owner === null ? "user/repos" : `orgs/${encodeURIComponent(owner)}/repos`,
          body: { name, private: input.visibility === "private" },
        });
        const decoded = decodeRawRepository(response.body);
        if (Result.isFailure(decoded)) {
          return yield* new GitHubRepositoryDecodeError({
            command: "gh",
            cwd: input.cwd,
            cause: decoded.failure,
          });
        }
        return repositoryCloneUrls(decoded.success);
      }),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const locator = yield* resolveRepository({ cwd: input.cwd });
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(Effect.mapError(gitFailure(input.cwd)));
        yield* rest(input.cwd, {
          host: locator.host,
          operation: "createPullRequest",
          method: "POST",
          path: `repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/pulls`,
          // `owner:branch` is how the REST API takes a fork's head, the same as `gh --head`.
          // gh allows maintainer edits unless told otherwise; the API's default is not documented.
          body: {
            base: input.baseBranch,
            head: input.headSelector,
            title: input.title,
            body,
            maintainer_can_modify: true,
          },
        });
      }),
    getDefaultBranch: (input) =>
      Effect.gen(function* () {
        const locator = yield* resolveRepository({ cwd: input.cwd, host: input.rateLimitHost });
        const repository = yield* readRepository(input.cwd, locator);
        const branch = repository.default_branch?.trim() ?? "";
        return branch.length > 0 ? branch : null;
      }),
    checkoutPullRequest,
  });
});

export const layer = Layer.effect(GitHubCli, make).pipe(
  Layer.provideMerge(GitHubApi.layer),
  Layer.provideMerge(GitHubCredentials.layer),
  Layer.provideMerge(GitHubGraphQlBudget.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
