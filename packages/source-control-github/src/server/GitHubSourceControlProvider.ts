import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  GraphQL,
  GraphQLClient,
  GraphQLClientError,
  GraphQLGroup,
  GraphQLResolver,
} from "effect/graphql";
import * as Option from "effect/Option";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderError,
  TrimmedNonEmptyString,
  type ChangeRequest,
  type SourceControlProviderDiscoveryItem,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";

import { GH_PROCESS_CONCURRENCY } from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubChangeRequestTemplate from "./gitHubChangeRequestTemplate.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import {
  normalizeGitHubPullRequestRecord,
  type NormalizedGitHubPullRequestRecord,
} from "./gitHubPullRequests.ts";
import {
  gitHubApiHostForRemote,
  parseFetchRemotes,
  parseGitHubRepositorySelector,
  parsePullRequestReference,
  resolveGitHubRepository,
  type GitHubRepositoryLocator,
} from "./gitHubRepositoryResolution.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  effectiveGitHubAccount,
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
  type GitHubAuthStatusAccount,
} from "./gitHubAuthStatus.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  probeSourceControlProvider,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";

import * as GitHubClient from "../shared/definition.ts";
import {
  PullRequestByNumber,
  PullRequestNode,
  PullRequestsByHead,
} from "./sourceControlProvider.graphql.ts";

/**
 * The generated head lookup with its rows left undecoded, so `listByHead` decodes them one at a
 * time: a row whose fields no longer decode is skipped rather than failing every lookup that
 * shared its document.
 */
const LenientPullRequestsByHead = GraphQL.query(PullRequestsByHead.name, {
  // The template, not the joined text: `GraphQLResolver.aliased` repeats it per lookup.
  document: PullRequestsByHead.template!,
  variables: PullRequestsByHead.variables,
  result: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequests: Schema.Struct({ nodes: Schema.NullOr(Schema.Array(Schema.Unknown)) }),
      }),
    ),
  }),
});
const decodePullRequestNode = Schema.decodeUnknownOption(PullRequestNode);

const decodeLinkSubject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ title: Schema.String, body: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

function toChangeRequest(record: NormalizedGitHubPullRequestRecord): ChangeRequest {
  return { provider: SourceControlProviderKind.make("github"), ...record };
}

function authAccounts(accounts: ReadonlyArray<GitHubAuthStatusAccount>) {
  return accounts.map((entry) => ({
    host: entry.host,
    account: entry.account,
    active: entry.active,
    authenticated: entry.authenticated,
    ...(entry.error === null ? {} : { error: entry.error }),
    ...(entry.environmentVariable === null
      ? {}
      : { environmentVariable: entry.environmentVariable }),
  }));
}

export function parseGitHubAuth(
  input: SourceControlAuthProbeInput,
  settings: GitHubClient.GitHubSettings = readSourceControlHostSettings(GitHubClient.settings, {}),
) {
  const output = combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const hosts = [...new Set(authStatus.accounts.map((entry) => entry.host))];
  const fallback = findAuthenticatedGitHubAccount(authStatus.accounts);
  const orderedHosts = fallback
    ? [fallback.host, ...hosts.filter((host) => host !== fallback.host)]
    : hosts;
  const chosen = orderedHosts
    .map((host) => effectiveGitHubAccount(host, authStatus.accounts, settings))
    .find((entry) => entry !== undefined);
  const accounts = authStatus.parsed ? { accounts: authAccounts(authStatus.accounts) } : {};

  if (chosen) {
    return {
      ...providerAuth({
        status: "authenticated",
        account: chosen.account,
        host: chosen.host,
        detail:
          chosen.environmentVariable === null
            ? undefined
            : `Using ${chosen.environmentVariable} from the server environment; it overrides the account chosen in Settings.`,
      }),
      ...accounts,
    };
  }

  if (fallback) {
    return {
      ...providerAuth({
        status: "unauthenticated",
        host: fallback.host,
        detail: "Every GitHub host gh is signed in to is turned off in Settings → Source Control.",
      }),
      ...accounts,
    };
  }

  const failedAccount = authStatus.accounts.find((entry) => entry.active) ?? authStatus.accounts[0];
  if (authStatus.parsed) {
    return {
      ...providerAuth({
        status: "unauthenticated",
        host: failedAccount?.host,
        detail:
          failedAccount?.error ??
          "Run `gh auth login` to authenticate GitHub CLI with an active account.",
      }),
      ...accounts,
    };
  }

  // gh gained `auth status --json` in 2.81.0. Older versions reject the flag and exit
  // non-zero, which reads exactly like a signed-out CLI.
  if (input.exitCode !== 0 && output.includes("unknown flag: --json")) {
    return providerAuth({
      status: "unknown",
      detail:
        "GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan.",
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail: firstSafeAuthLine(output) ?? "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    detail: firstSafeAuthLine(output) ?? "GitHub CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("github"),
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;

const decodeViewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);

function environmentTokenVariable(environment: NodeJS.ProcessEnv): string | null {
  return ["GH_TOKEN", "GITHUB_TOKEN"].find((name) => environment[name]?.trim()) ?? null;
}

/**
 * An environment token is checked against the API, since `gh auth status` may
 * not know it.
 */
export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const process = sourceControlHost.process;
  const environment = yield* HostProcess.Environment;

  return {
    type: "managed-cli",
    kind: discovery.kind,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("GitHubSourceControlProvider.discovery")(function* (cwd: string) {
      const settings = readSourceControlHostSettings(
        GitHubClient.settings,
        yield* sourceControlHost.settings.get.pipe(
          Effect.map((current) => current.sourceControlHosts[GitHubClient.definition.kind]),
          Effect.orElseSucceed(() => undefined),
        ),
      );
      const cli = yield* probeSourceControlProvider({
        cwd,
        process: {
          run: (input) => process.run({ ...input, concurrency: GH_PROCESS_CONCURRENCY }),
        },
        spec: { ...discovery, parseAuth: (input) => parseGitHubAuth(input, settings) },
      });
      const savedToken = (settings.tokens["github.com"] ?? "").trim() !== "";
      const variable = environmentTokenVariable(environment);
      const tokenSource = savedToken ? "the token saved in Settings" : variable;
      if (tokenSource === null || settings.hosts["github.com"]?.enabled === false) return cli;
      const viewer = yield* api
        .rest({ host: "github.com", operation: "discovery", path: "user" })
        .pipe(Effect.result);
      const login = Result.isSuccess(viewer)
        ? Option.getOrUndefined(decodeViewer(viewer.success.body))?.login
        : undefined;
      const accounts = cli.auth.accounts === undefined ? {} : { accounts: cli.auth.accounts };
      return {
        ...cli,
        status: "available" as const,
        auth: {
          ...(login !== undefined
            ? providerAuth({
                status: "authenticated",
                account: login,
                host: "github.com",
                detail: savedToken
                  ? "Using the token saved in Settings; it overrides GH_TOKEN and the gh login."
                  : `Using ${variable} from the server environment; it overrides the account chosen in Settings.`,
              })
            : Result.isFailure(viewer) && viewer.failure._tag !== "GitHubApiAuthenticationError"
              ? providerAuth({
                  status: "unknown",
                  host: "github.com",
                  detail: `Could not check ${savedToken ? tokenSource : `the token in ${tokenSource}`}: ${viewer.failure.message}`,
                })
              : providerAuth({
                  status: "unauthenticated",
                  host: "github.com",
                  detail: savedToken
                    ? "GitHub refused the token saved in Settings. Replace or remove it in Settings → Source Control."
                    : `GitHub refused the token in ${tokenSource}. Replace it, or unset it to use \`gh auth login\`.`,
                })),
          ...accounts,
        },
      } satisfies SourceControlProviderDiscoveryItem;
    }),
    /**
     * A host turned off in Settings is claimed too, so its error says so
     * instead of "unsupported host".
     */
    refineUnknownRemote: ({ context }) => {
      const url = URL.parse(context.provider.baseUrl);
      if (!url?.host) return Effect.succeed(null);
      // A timeout or keyring failure propagates: the registry does not keep that answer.
      return api.credential(url.host).pipe(
        Effect.as(true),
        Effect.catchTags({
          GitHubCliMissingError: () => Effect.succeed(false),
          GitHubHostDisabledError: () => Effect.succeed(true),
          GitHubNotSignedInError: () => Effect.succeed(false),
        }),
        Effect.map((known) =>
          known
            ? ({
                kind: SourceControlProviderKind.make("github"),
                name: "GitHub Self-Hosted",
                baseUrl: context.provider.baseUrl,
              } as const)
            : null,
        ),
      );
    },
  } satisfies SourceControlManagedCliDiscoverySpec;
});

class GitHubFailure extends Data.TaggedError("GitHubFailure")<{
  readonly detail: string;
  readonly cause: unknown;
}> {}

const failure = (detail: string, cause?: unknown) => new GitHubFailure({ detail, cause });

const PULL_REQUEST_NOT_FOUND = "Pull request not found. Check the PR number or URL and try again.";
const REPOSITORY_NOT_FOUND = "Repository not found. Check the owner and name and try again.";

function fromGitHubApiError(
  error: GitHubRequestPolicy.GitHubApiError,
  notFound = PULL_REQUEST_NOT_FOUND,
): GitHubFailure {
  switch (error._tag) {
    case "GitHubCliMissingError":
      return failure(
        "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.",
        error,
      );
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
      return failure(error.message, error);
    case "GitHubApiAuthenticationError":
      return failure(
        "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
        error,
      );
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return failure(
        "GitHub API rate limit exceeded. Requests resume when the limit resets.",
        error,
      );
    case "GitHubApiNotFoundError":
      return failure(notFound, error);
    case "GitHubCliFailedError":
    case "GitHubApiResponseError":
    case "GitHubApiRequestError":
      return failure(error.message.trim() || "GitHub request failed.", error);
  }
}

const notFound = (cause: string) => failure(PULL_REQUEST_NOT_FOUND, new Error(cause));

const RawRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  ssh_url: TrimmedNonEmptyString,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRawRepository = decodeJsonResult(RawRepositorySchema);

function repositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawRepositorySchema>,
): SourceControlRepositoryCloneUrls {
  return { nameWithOwner: raw.full_name, url: raw.html_url, sshUrl: raw.ssh_url };
}

const decodeViewerLogin = decodeJsonResult(Schema.Struct({ login: TrimmedNonEmptyString }));

type PullRequestListState = "open" | "closed" | "merged" | "all";

const GRAPHQL_STATES: Record<
  PullRequestListState,
  NonNullable<PullRequestsByHead.Variables["states"]>
> = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
};
/**
 * A document of a hundred costs one point, the same as one single lookup, but
 * half that keeps each answer near half a second.
 */
const HEAD_LOOKUPS_PER_DOCUMENT = 50;
/**
 * Branch discovery reaches GitHub only after each branch's own git reads, so lookups started
 * together arrive tens of milliseconds apart. A background sweep's lookups spread over up to
 * ~300ms, and every document costs a point no matter how few heads it holds, so reads
 * without reserve wait longer.
 */
const HEAD_LOOKUP_BATCH_WINDOW = "50 millis";
const BACKGROUND_HEAD_LOOKUP_BATCH_WINDOW = "500 millis";
/**
 * Background documents fill up under the longer window, and a failed document fails every head
 * in it. Fifty `main`-like heads of a hundred pull requests each took up to ~10s, GitHub's own
 * processing limit; twenty-five took ~7s.
 */
const BACKGROUND_HEAD_LOOKUPS_PER_DOCUMENT = 25;
const HEAD_LOOKUP_MAX_RESPONSE_BYTES = 16_000_000;
const OWNER_HEAD_SCAN_LIMIT = 100;

function trimmed(value: string): string | null {
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/**
 * A pull request as every read reports it, or null for a row this cannot use: a number below
 * one, a blank title, URL or branch name, or an `updatedAt` that is not a date. A list skips a
 * null, so one such row cannot hide the rest. The generated schema already holds every row to
 * GitHub's own types, with `state` as a lenient enum.
 */
function toPullRequestRecord(node: PullRequestNode): NormalizedGitHubPullRequestRecord | null {
  const title = trimmed(node.title);
  const url = trimmed(node.url);
  const baseRefName = trimmed(node.baseRefName);
  const headRefName = trimmed(node.headRefName);
  const updatedAt = DateTime.make(node.updatedAt);
  if (node.number < 1 || !title || !url || !baseRefName || !headRefName) return null;
  if (Option.isNone(updatedAt)) return null;
  return normalizeGitHubPullRequestRecord({
    ...node,
    title,
    url,
    baseRefName,
    headRefName,
    updatedAt: Option.some(DateTime.toUtc(updatedAt.value)),
  });
}

export function pullRequestCheckoutBranchName(input: {
  readonly headRefName: string;
  readonly headOwner: string | null;
  readonly isCrossRepository: boolean;
  readonly defaultBranch: string | null;
}): string {
  return input.isCrossRepository &&
    input.headOwner !== null &&
    input.defaultBranch !== null &&
    input.headRefName === input.defaultBranch
    ? `${input.headOwner}/${input.headRefName}`
    : input.headRefName;
}

const contextHost = (context: SourceControlProvider.SourceControlProviderContext | undefined) =>
  context === undefined ? undefined : new URL(context.provider.baseUrl).host;

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const process = sourceControlHost.process;
  const environment = yield* HostProcess.Environment;
  const git = sourceControlHost.git;
  const fileSystem = yield* FileSystem.FileSystem;

  const gitRead = (cwd: string, args: ReadonlyArray<string>) =>
    process.run({
      operation: "GitHubSourceControlProvider.resolveRepository",
      command: "git",
      args,
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    });

  const resolveRepository = Effect.fn("GitHubSourceControlProvider.resolveRepository")(
    function* (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly context?: SourceControlProvider.SourceControlProviderContext | undefined;
    }) {
      const envRepository = environment.GH_REPO?.trim();
      const hostHint = input.host ?? contextHost(input.context);
      const defaultHost = (hostHint ?? environment.GH_HOST ?? "github.com").toLowerCase();
      if (envRepository) {
        const locator = parseGitHubRepositorySelector(envRepository, defaultHost);
        if (locator !== null) return locator;
      }
      const [remotes, resolved] = yield* Effect.all([
        gitRead(input.cwd, ["remote", "-v"]),
        gitRead(input.cwd, ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]),
      ]).pipe(Effect.orElseSucceed(() => [null, null] as const));
      const { host, locator } = resolveGitHubRepository({
        remotes: remotes?.exitCode === 0 ? remotes.stdout : "",
        resolved: resolved?.exitCode === 0 ? resolved.stdout : "",
        hostHint,
        defaultHost,
      });
      if (locator !== null) return locator;
      if (input.context) {
        const remote = normalizeGitRemoteUrl(input.context.remoteUrl);
        const fallback = parseGitHubRepositorySelector(
          `${host}/${remote.slice(remote.indexOf("/") + 1)}`,
          host,
        );
        if (fallback !== null) return fallback;
      }
      return yield* failure(
        `No GitHub repository on ${host} was found among this checkout's git remotes.`,
      );
    },
  );

  const client = yield* GraphQLClient.make(
    GraphQLGroup.make(LenientPullRequestsByHead, PullRequestByNumber).middleware(
      GitHubGraphQlClient.GitHubGraphQlAuth,
    ),
  ).pipe(Effect.provide(GitHubGraphQlClient.layer));

  /**
   * Runs a generated read against `target`. GitHub's refusals and `errors` fail the way REST
   * ones do; an answer that does not decode is a `decodeDetail` failure.
   */
  const graphqlRead = <A, E, R>(
    target: GitHubGraphQlClient.GitHubGraphQlTarget["Service"],
    decodeDetail: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      GitHubGraphQlClient.call(target),
      Effect.mapError((error) =>
        GraphQLClientError.isGraphQLClientError(error)
          ? failure(decodeDetail, error)
          : fromGitHubApiError(error as GitHubRequestPolicy.GitHubApiError),
      ),
    );

  const rest = (input: GitHubRest.GitHubRestInput, notFoundDetail?: string) =>
    api.rest(input).pipe(Effect.mapError((error) => fromGitHubApiError(error, notFoundDetail)));

  /**
   * Head lookups to one host under one credential share aliased documents: the resolver batches by
   * the host's endpoint and `batchKey`. Each lookup has its own `repository` root, so lookups on
   * different repositories may share a document, and a repository GitHub cannot find fails only
   * its own. Interactive and background lookups never share one, since they use separate
   * resolvers, so a document is sent under one reserve setting.
   */
  const headResolver = GraphQLResolver.aliased(client.PullRequestsByHead, {
    batchKey: GitHubGraphQlClient.batchKey,
  }).pipe(RequestResolver.batchN(HEAD_LOOKUPS_PER_DOCUMENT));
  const interactiveHeadResolver = headResolver.pipe(
    RequestResolver.setDelay(HEAD_LOOKUP_BATCH_WINDOW),
  );
  const backgroundHeadResolver = headResolver.pipe(
    RequestResolver.batchN(BACKGROUND_HEAD_LOOKUPS_PER_DOCUMENT),
    RequestResolver.setDelay(BACKGROUND_HEAD_LOOKUP_BATCH_WINDOW),
  );

  const listByHead = Effect.fn("GitHubSourceControlProvider.listByHead")(function* (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly state: PullRequestListState;
    readonly limit: number;
    readonly context?: SourceControlProvider.SourceControlProviderContext | undefined;
    readonly host?: string | undefined;
    readonly allowReserve: boolean;
  }) {
    const locator = yield* resolveRepository(input);
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
    const ownerMatch = /^([^:/\s]+):(.+)$/u.exec(input.headSelector.trim());
    const headRefName = ownerMatch?.[2] ?? input.headSelector.trim();
    const result = yield* graphqlRead(
      {
        host: locator.host,
        operation: "listPullRequestsByHead",
        allowReserve: input.allowReserve,
        // Up to 50 heads of 100 rows each. A default branch such as `main` can match a hundred
        // fork pull requests, so the usual cap would cut the answer short.
        maxResponseBytes: HEAD_LOOKUP_MAX_RESPONSE_BYTES,
      },
      "GitHub returned an invalid change request list.",
      GraphQLResolver.request(
        {
          owner: locator.owner,
          name: locator.name,
          head: headRefName,
          states: GRAPHQL_STATES[input.state],
          first: ownerMatch ? OWNER_HEAD_SCAN_LIMIT : limit,
        },
        input.allowReserve ? interactiveHeadResolver : backgroundHeadResolver,
      ),
    );
    if (result.repository === null) return yield* notFound("The repository could not be read.");
    const rows = (result.repository.pullRequests.nodes ?? []).flatMap((entry) => {
      const node = Option.getOrNull(decodePullRequestNode(entry));
      const record = node === null ? null : toPullRequestRecord(node);
      return record === null ? [] : [record];
    });
    if (!ownerMatch) return rows;
    const headOwner = ownerMatch[1]!.toLowerCase();
    return rows
      .filter((row) => row.headRepositoryOwnerLogin?.toLowerCase() === headOwner)
      .slice(0, limit);
  });

  const readPullRequest = Effect.fn("GitHubSourceControlProvider.readPullRequest")(
    function* (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext | undefined;
      readonly host?: string | undefined;
    }) {
      const parsed = parsePullRequestReference(input.reference);
      if (parsed.kind === "branch") {
        // `gh pr view <branch>` prefers an open pull request, then the newest of any state.
        const lookup = (state: PullRequestListState) =>
          listByHead({
            cwd: input.cwd,
            headSelector: parsed.headSelector,
            state,
            limit: 1,
            host: input.host,
            context: input.context,
            allowReserve: true,
          });
        const [open] = yield* lookup("open");
        const found = open ?? (yield* lookup("all"))[0];
        if (found === undefined) return yield* notFound("No pull request has this head branch.");
        return found;
      }
      const locator = parsed.kind === "url" ? parsed.locator : yield* resolveRepository(input);
      const decodeDetail = "GitHub returned an invalid pull request.";
      const result = yield* graphqlRead(
        { host: locator.host, operation: "getPullRequest", allowReserve: true },
        decodeDetail,
        client.PullRequestByNumber({
          owner: locator.owner,
          name: locator.name,
          number: parsed.number,
        }),
      );
      const node = result.repository?.pullRequest;
      if (node == null) return yield* notFound("The pull request does not exist.");
      const record = toPullRequestRecord(node);
      if (record === null)
        return yield* failure(decodeDetail, new Error("Malformed pull request."));
      return record;
    },
  );

  const readRepository = Effect.fn("GitHubSourceControlProvider.readRepository")(function* (
    locator: GitHubRepositoryLocator,
  ) {
    const response = yield* rest(
      {
        host: locator.host,
        operation: "getRepository",
        path: `repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`,
        allowReserve: true,
      },
      REPOSITORY_NOT_FOUND,
    );
    const decoded = decodeRawRepository(response.body);
    if (Result.isFailure(decoded)) {
      return yield* failure("GitHub returned an invalid repository.", decoded.failure);
    }
    return decoded.success;
  });

  const readViewerLogin = Effect.fn("GitHubSourceControlProvider.readViewerLogin")(function* (
    host: string,
  ) {
    const response = yield* rest({
      host,
      operation: "getViewer",
      path: "user",
      allowReserve: true,
    });
    const decoded = decodeViewerLogin(response.body);
    if (Result.isFailure(decoded)) {
      return yield* failure("GitHub request failed.", decoded.failure);
    }
    return decoded.success.login;
  });

  // Git and filesystem errors can carry arguments, paths and stderr, so the detail a client
  // sees is fixed and the raw error stays in `cause`.
  const gitFailure = (cause: unknown) =>
    failure("The pull request could not be checked out with git.", cause);

  const runGit = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: `GitHubSourceControlProvider.checkoutPullRequest.${operation}`,
      cwd,
      args,
    });

  /**
   * An existing branch fast-forwards, or with `force` is reset to the pull request.
   */
  const checkoutPullRequest = Effect.fn("GitHubSourceControlProvider.checkoutPullRequest")(
    function* (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) {
      const reference = parsePullRequestReference(input.reference);
      const pullRequest = yield* readPullRequest(input);
      const base = reference.kind === "url" ? reference.locator : yield* resolveRepository(input);
      const baseNameWithOwner = `${base.owner}/${base.name}`.toLowerCase();
      const headNameWithOwner = pullRequest.headRepositoryNameWithOwner ?? null;
      const isCrossRepository =
        pullRequest.isCrossRepository ??
        (headNameWithOwner !== null && headNameWithOwner.toLowerCase() !== baseNameWithOwner);
      const headOwner =
        pullRequest.headRepositoryOwnerLogin ?? headNameWithOwner?.split("/")[0] ?? null;

      const remotes = yield* gitRead(input.cwd, ["remote", "-v"]).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout : "")),
        Effect.mapError(gitFailure),
      );
      const remoteFor = (nameWithOwner: string) =>
        parseFetchRemotes(remotes).find(
          (remote) =>
            (gitHubApiHostForRemote(remote.url) ??
              normalizeGitRemoteUrl(remote.url).split("/")[0]) === base.host &&
            normalizeGitRemoteUrl(remote.url).split("/").slice(1).join("/") ===
              nameWithOwner.toLowerCase(),
        )?.name ?? null;
      const baseRemote = Effect.suspend(() => {
        const known = remoteFor(baseNameWithOwner);
        return known === null ? git.resolvePrimaryRemoteName(input.cwd) : Effect.succeed(known);
      });
      // A fork's branch named like the base's default branch is checked out under the owner's
      // prefix. Without the default branch that collision cannot be ruled out, and the checkout
      // would reset the local default branch to the fork's commit, so it fails instead.
      const defaultBranch = isCrossRepository
        ? yield* readRepository(base).pipe(
            Effect.map((repository) => repository.default_branch ?? null),
          )
        : null;
      const localBranch = pullRequestCheckoutBranchName({
        headRefName: pullRequest.headRefName,
        headOwner,
        isCrossRepository,
        defaultBranch,
      });

      const headRemote = Effect.gen(function* () {
        if (!isCrossRepository) return yield* baseRemote;
        if (headNameWithOwner === null) return yield* failure("The fork is gone.");
        const known = remoteFor(headNameWithOwner);
        if (known !== null) return known;
        const [owner, name] = headNameWithOwner.split("/");
        const fork = yield* readRepository({ host: base.host, owner: owner!, name: name! });
        const originUrl = yield* git.readConfigValue(input.cwd, "remote.origin.url");
        return yield* git.ensureRemote({
          cwd: input.cwd,
          preferredName: headOwner ?? "fork",
          url: originUrl !== null && isSshRemoteUrl(originUrl) ? fork.ssh_url : fork.html_url,
        });
      });

      const exists = (yield* git
        .listLocalBranchNames(input.cwd)
        .pipe(Effect.mapError(gitFailure))).includes(localBranch);

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
              "--",
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
        Effect.mapError(gitFailure),
      );

      yield* Effect.gen(function* () {
        if (!exists) yield* runGit(input.cwd, "branch", ["branch", "--", localBranch, target.ref]);
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
      }).pipe(Effect.mapError(gitFailure));
    },
  );

  const providerError =
    (
      operation: string,
      cwd: string,
      context?: { readonly reference?: string; readonly repository?: string },
    ) =>
    (error: GitHubFailure) =>
      new SourceControlProviderError({
        provider: SourceControlProviderKind.make("github"),
        operation,
        cwd,
        ...(context?.reference === undefined
          ? {}
          : {
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                context.reference,
              ),
            }),
        ...(context?.repository === undefined
          ? {}
          : {
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                context.repository,
              ),
            }),
        detail: error.detail,
        cause: error.cause,
      });

  const readLinkSubject = Effect.fn("GitHubSourceControlProvider.readLinkSubject")(function* (
    input: { readonly cwd: string; readonly url: URL },
    endpoint: string,
  ) {
    const result = yield* api
      .rest({
        host: input.url.host,
        operation: "resolveLink",
        path: endpoint,
        maxResponseBytes: 1_000_000,
      })
      .pipe(
        Effect.timeout("3 seconds"),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("github"),
              operation: "resolveLink",
              cwd: input.cwd,
              detail: "The linked subject could not be read.",
              cause,
            }),
        ),
      );
    const subject = yield* decodeLinkSubject(result.body).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: SourceControlProviderKind.make("github"),
            operation: "resolveLink.decode",
            cwd: input.cwd,
            detail: "The linked subject could not be read.",
            cause,
          }),
      ),
    );
    return { title: subject.title, body: subject.body ?? null };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("github"),
    // `gh pr list --head` filters on the head ref name alone and accepts anything, so an
    // `owner:branch` or `remote:branch` selector silently lists zero pull requests while
    // spending a GraphQL call; the bare branch is always among the selectors. Without the owner,
    // a bare branch also lists same-named branches on other forks (`main`, `patch-1`), so read a
    // full page and let the owner check pick the right head.
    headBranchProbe: ({ headSelectors }) => ({
      headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
      limit: 100,
    }),
    readChangeRequestTemplate: ({ cwd, treeish }) =>
      GitHubChangeRequestTemplate.detect(cwd, treeish, git.execute),
    // `createChangeRequest` targets what `resolveRepository` picks: GH_REPO when it parses, else
    // the remote `gh repo set-default` marked (`gh-resolved`). An HTTPS remote keeps a
    // non-default port in the context's host, and the mark is then ignored.
    createsChangeRequestsIn: Effect.fn("GitHubSourceControlProvider.createsChangeRequestsIn")(
      function* ({ cwd, context, repository }) {
        const host = URL.canParse(context.provider.baseUrl)
          ? new URL(context.provider.baseUrl).host
          : null;
        const target = repository?.toLowerCase();
        const fromEnvironment = parseGitHubRepositorySelector(
          environment.GH_REPO ?? "",
          host ?? "",
        );
        if (fromEnvironment !== null) {
          const { host: targetHost, owner, name } = fromEnvironment;
          return (
            host !== null &&
            URL.canParse(`https://${targetHost}`) &&
            new URL(`https://${targetHost}`).host === host &&
            `${owner}/${name}`.toLowerCase() === target
          );
        }
        const mark = yield* git
          .readConfigValue(cwd, `remote.${context.remoteName}.gh-resolved`)
          .pipe(Effect.orElseSucceed(() => null));
        const { locator } = resolveGitHubRepository({
          remotes: `${context.remoteName}\t${context.remoteUrl} (fetch)`,
          resolved: mark === null ? "" : `remote.${context.remoteName}.gh-resolved ${mark}`,
          hostHint: host ?? undefined,
          defaultHost: host ?? "github.com",
        });
        return locator === null || `${locator.owner}/${locator.name}`.toLowerCase() === target;
      },
    ),
    // `gh pr create` run in the checkout, as an agent in a T3 worktree often does, takes its base
    // from this key.
    recordBranchBase: ({ cwd, branch, baseBranch }) =>
      git
        .execute({
          operation: "GitHubSourceControlProvider.recordBranchBase",
          cwd,
          args: ["config", `branch.${branch}.gh-merge-base`, baseBranch],
        })
        .pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("Could not record the branch base for gh", { cause }),
          ),
        ),
    resolveLink: (input) => {
      // Automatic enrichment must not send ambient CLI credentials to a host from message text.
      if (input.url.host !== "github.com") return undefined;
      const match = /^\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(
        input.url.pathname,
      );
      if (!match) return undefined;
      return readLinkSubject(input, `repos/${match[1]}/${match[2]}/issues/${match[3]}`);
    },
    listChangeRequests: (input) =>
      (input.state === "open" ? Effect.succeed(true) : SourceControlRateLimit.Interactive).pipe(
        Effect.flatMap((allowReserve) =>
          listByHead({
            cwd: input.cwd,
            headSelector: input.headSelector,
            state: input.state,
            limit: input.limit ?? (input.state === "open" ? 1 : 20),
            host: contextHost(input.context),
            context: input.context,
            allowReserve,
          }),
        ),
        Effect.map((records) => records.map(toChangeRequest)),
        Effect.mapError(
          providerError("listChangeRequests", input.cwd, { reference: input.headSelector }),
        ),
      ),
    getChangeRequest: (input) =>
      readPullRequest({ ...input, host: contextHost(input.context) }).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          providerError("getChangeRequest", input.cwd, { reference: input.reference }),
        ),
      ),
    createChangeRequest: Effect.fn("GitHubSourceControlProvider.createChangeRequest")(
      function* (input) {
        const locator = yield* resolveRepository(input);
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              failure("The pull request description could not be read.", cause),
            ),
          );
        yield* rest({
          host: locator.host,
          operation: "createPullRequest",
          method: "POST",
          allowReserve: true,
          path: `repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/pulls`,
          // `owner:branch` is how the REST API takes a fork's head, the same as `gh --head`.
          // gh allows maintainer edits unless told otherwise; the API's default is not documented.
          body: {
            base: input.baseRefName,
            head: input.headSelector,
            title: input.title,
            body,
            maintainer_can_modify: true,
          },
        });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("createChangeRequest", input.cwd, { reference: input.headSelector }),
          ),
        ),
    ),
    getRepositoryCloneUrls: Effect.fn("GitHubSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const fallbackHost = (yield* resolveRepository(input).pipe(
          Effect.map((locator) => locator.host),
          Effect.orElseSucceed(() => environment.GH_HOST ?? "github.com"),
        )).toLowerCase();
        const bareName = input.repository.trim().replace(/\.git$/i, "");
        const locator =
          parseGitHubRepositorySelector(input.repository, fallbackHost) ??
          (/^[^/\s]+$/.test(bareName)
            ? { host: fallbackHost, owner: yield* readViewerLogin(fallbackHost), name: bareName }
            : null);
        if (locator === null) return yield* failure("Repositories are named owner/name.");
        return repositoryCloneUrls(yield* readRepository(locator));
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("getRepositoryCloneUrls", input.cwd, { repository: input.repository }),
          ),
        ),
    ),
    createRepository: Effect.fn("GitHubSourceControlProvider.createRepository")(
      function* (input) {
        const locator = parseGitHubRepositorySelector(
          input.repository,
          (environment.GH_HOST ?? "github.com").toLowerCase(),
        );
        const viewer = locator === null ? null : yield* readViewerLogin(locator.host);
        const owner = locator?.owner ?? viewer;
        const name = locator?.name ?? input.repository.trim();
        const host = locator?.host ?? (environment.GH_HOST?.trim().toLowerCase() || "github.com");
        const isViewer = viewer !== null && owner?.toLowerCase() === viewer.toLowerCase();
        const response = yield* rest(
          {
            host,
            operation: "createRepository",
            method: "POST",
            allowReserve: true,
            path:
              isViewer || owner === null ? "user/repos" : `orgs/${encodeURIComponent(owner)}/repos`,
            body: { name, private: input.visibility === "private" },
          },
          // GitHub answers 404 for an organization the account cannot create repositories in.
          `No organization named ${owner ?? "that"} that this account can create repositories in.`,
        );
        const decoded = decodeRawRepository(response.body);
        if (Result.isFailure(decoded)) {
          return yield* failure("GitHub returned an invalid repository.", decoded.failure);
        }
        return repositoryCloneUrls(decoded.success);
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            providerError("createRepository", input.cwd, { repository: input.repository }),
          ),
        ),
    ),
    getDefaultBranch: Effect.fn("GitHubSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const locator = yield* resolveRepository({
          cwd: input.cwd,
          host: contextHost(input.context),
          context: input.context,
        });
        const repository = yield* readRepository(locator);
        const branch = repository.default_branch?.trim() ?? "";
        return branch.length > 0 ? branch : null;
      },
      (effect, input) => effect.pipe(Effect.mapError(providerError("getDefaultBranch", input.cwd))),
    ),
    checkoutChangeRequest: (input) =>
      checkoutPullRequest(input).pipe(
        Effect.mapError(
          providerError("checkoutChangeRequest", input.cwd, { reference: input.reference }),
        ),
      ),
  });
});
