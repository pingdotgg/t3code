import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as ForgejoKeyStore from "./ForgejoKeyStore.ts";
import * as ForgejoPullRequests from "./forgejoPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class ForgejoApiError extends Schema.TaggedErrorClass<ForgejoApiError>()("ForgejoApiError", {
  operation: Schema.String,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Forgejo API failed in ${this.operation}: ${this.detail}`;
  }
}
const isForgejoApiErrorValue = Schema.is(ForgejoApiError);

// Forgejo's pulls list cannot filter by head branch, so we over-fetch a page of recently
// updated PRs and filter in memory. This is the per-fetch page size (Forgejo's API max),
// independent of the caller's `limit` (which caps the matching results).
const PULL_REQUEST_PAGE_SIZE = 50;

const ForgejoRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  clone_url: Schema.optional(Schema.NullOr(Schema.String)),
  ssh_url: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface ForgejoRepositoryLocator {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly scheme: "http" | "https";
}

export interface ForgejoApiShape {
  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<ForgejoPullRequests.NormalizedForgejoPullRequestRecord>,
    ForgejoApiError
  >;
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ForgejoPullRequests.NormalizedForgejoPullRequestRecord, ForgejoApiError>;
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly target?: SourceControlProvider.SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, ForgejoApiError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<string | null, ForgejoApiError>;
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, ForgejoApiError>;
}

export class ForgejoApi extends Context.Service<ForgejoApi, ForgejoApiShape>()(
  "t3/sourceControl/ForgejoApi",
) {}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/u, "");
  const urlMatch = /(?:pulls|pull)\/(\d+)(?:\D.*)?$/iu.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function parseRepoPath(pathname: string): { owner: string; repo: string } | null {
  const normalized = pathname.trim().replace(/\.git$/u, "").replace(/^\/+/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const owner = parts.at(-2);
  const repo = parts.at(-1);
  return owner && repo ? { owner, repo } : null;
}

export function stripHostPort(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/u, "");
}

// `fj` keys its login store and `fj auth list` output by bare hostname, while remote URLs
// can carry a `:port`. Match host identities port-insensitively (but keep the full host for
// constructing API base URLs, which need the port).
export function forgejoHostsMatch(a: string, b: string): boolean {
  const an = a.trim().toLowerCase();
  const bn = b.trim().toLowerCase();
  return an === bn || stripHostPort(an) === stripHostPort(bn);
}

export function parseForgejoRemoteUrl(remoteUrl: string): ForgejoRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.startsWith("git@")) {
    const hostStart = "git@".length;
    const colon = trimmed.indexOf(":");
    if (colon < 0) return null;
    const host = trimmed.slice(hostStart, colon).toLowerCase();
    const parsed = parseRepoPath(trimmed.slice(colon + 1));
    // SSH remotes don't imply an API scheme; default to https.
    return parsed ? { host, scheme: "https", ...parsed } : null;
  }
  try {
    const url = new URL(trimmed);
    const parsed = parseRepoPath(url.pathname);
    const scheme = url.protocol === "http:" ? "http" : "https";
    return parsed ? { host: url.host.toLowerCase(), scheme, ...parsed } : null;
  } catch {
    return null;
  }
}

export function parseForgejoRepositorySpec(
  value: string,
  fallbackHost: string | null,
): ForgejoRepositoryLocator | null {
  const trimmed = value.trim();
  // A pasted clone URL (`https://host/owner/repo`, `ssh://…`, or `git@host:owner/repo`) carries
  // its own host — parse it as a remote rather than splitting naively on `/`.
  if (trimmed.startsWith("git@") || /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    return parseForgejoRemoteUrl(trimmed);
  }
  const normalized = trimmed.replace(/\.git$/u, "").replace(/^\/+/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length >= 3) {
    const repo = parts.at(-1);
    const owner = parts.at(-2);
    const host = parts.slice(0, -2).join("/").toLowerCase();
    return owner && repo && host ? { host, owner, repo, scheme: "https" } : null;
  }
  if (parts.length === 2 && fallbackHost) {
    return { host: fallbackHost.toLowerCase(), owner: parts[0]!, repo: parts[1]!, scheme: "https" };
  }
  return null;
}

function normalizeRepositoryCloneUrls(
  raw: typeof ForgejoRepositorySchema.Type,
  host: string,
): SourceControlRepositoryCloneUrls {
  const httpUrl =
    raw.clone_url?.trim() || raw.html_url?.trim() || `https://${host}/${raw.full_name}.git`;
  const sshUrl = raw.ssh_url?.trim() || `git@${host}:${raw.full_name}.git`;
  return { nameWithOwner: raw.full_name, url: httpUrl, sshUrl };
}

function shouldPreferSshRemote(originRemoteUrl: string | null): boolean {
  const trimmed = originRemoteUrl?.trim() ?? "";
  return trimmed.startsWith("git@") || trimmed.startsWith("ssh://");
}

function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  if (!input.isCrossRepository) return input.headBranch;
  return `t3code/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`;
}

function requestError(operation: string, cause: unknown): ForgejoApiError {
  return new ForgejoApiError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function isForgejoApiError(cause: unknown): cause is ForgejoApiError {
  return isForgejoApiErrorValue(cause);
}

function responseError(
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, ForgejoApiError> {
  return response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((body) =>
      Effect.fail(
        new ForgejoApiError({
          operation,
          status: response.status,
          detail:
            body.trim().length > 0
              ? `Forgejo returned HTTP ${response.status}: ${body.trim()}`
              : `Forgejo returned HTTP ${response.status}.`,
        }),
      ),
    ),
  );
}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const keyStore = yield* ForgejoKeyStore.ForgejoKeyStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const apiUrl = (locator: Pick<ForgejoRepositoryLocator, "host" | "scheme">, path: string) =>
    `${locator.scheme}://${locator.host}/api/v1${path}`;

  const withAuth = (host: string, request: HttpClientRequest.HttpClientRequest) =>
    keyStore.getCredential(host).pipe(
      Effect.map((credential) =>
        credential === null
          ? request
          : request.pipe(HttpClientRequest.setHeader(...keyStore.authHeader(credential))),
      ),
    );

  const decodeResponse = <S extends Schema.Top>(
    operation: string,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoApiError({
                operation,
                detail: "Forgejo returned invalid JSON for the requested resource.",
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: string,
    host: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    withAuth(host, request.pipe(HttpClientRequest.acceptJson)).pipe(
      Effect.flatMap((authed) => httpClient.execute(authed)),
      Effect.mapError((cause) => (isForgejoApiError(cause) ? cause : requestError(operation, cause))),
      Effect.flatMap((response) => decodeResponse(operation, schema, response)),
    );

  const resolveRepository = Effect.fn("ForgejoApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    const hosts = yield* keyStore.listHosts;
    const contextHost =
      input.context?.provider.kind === "forgejo"
        ? (parseForgejoRemoteUrl(input.context.remoteUrl)?.host ?? null)
        : null;
    // Mirror createRepository: when exactly one Forgejo instance is logged in, accept a bare
    // `owner/repo` spec (e.g. the add-project clone flow, which runs in a dir with no remotes).
    const fallbackHost = contextHost ?? (hosts.length === 1 ? hosts[0]! : null);

    if (input.repository !== undefined) {
      const fromSpec = parseForgejoRepositorySpec(input.repository, fallbackHost);
      if (fromSpec) return fromSpec;
    }

    if (input.context?.provider.kind === "forgejo") {
      const fromContext = parseForgejoRemoteUrl(input.context.remoteUrl);
      if (fromContext) return fromContext;
    }

    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoApiError({
            operation: "resolveRepository",
            detail: `Failed to resolve VCS repository for ${input.cwd}.`,
            cause,
          }),
      ),
    );
    const remotes = yield* handle.driver.listRemotes(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoApiError({
            operation: "resolveRepository",
            detail: `Failed to list remotes for ${input.cwd}.`,
            cause,
          }),
      ),
    );

    for (const remote of remotes.remotes) {
      const parsed = parseForgejoRemoteUrl(remote.url);
      if (!parsed) continue;
      const isForgejo =
        hosts.some((host) => forgejoHostsMatch(host, parsed.host)) ||
        detectSourceControlProviderFromRemoteUrl(remote.url)?.kind === "forgejo";
      if (isForgejo) return parsed;
    }

    return yield* new ForgejoApiError({
      operation: "resolveRepository",
      detail: `No Forgejo repository remote was detected for ${input.cwd}.`,
    });
  });

  const getRepositoryFromLocator = (locator: ForgejoRepositoryLocator) =>
    executeJson(
      "getRepository",
      locator.host,
      HttpClientRequest.get(
        apiUrl(
          locator,
          `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repo)}`,
        ),
      ),
      ForgejoRepositorySchema,
    );

  const getRawPullRequestFromLocator = (locator: ForgejoRepositoryLocator, reference: string) =>
    executeJson(
      "getPullRequest",
      locator.host,
      HttpClientRequest.get(
        apiUrl(
          locator,
          `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repo)}/pulls/${encodeURIComponent(normalizeChangeRequestId(reference))}`,
        ),
      ),
      ForgejoPullRequests.ForgejoPullRequestSchema,
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    git.readConfigValue(cwd, key).pipe(Effect.orElseSucceed(() => null));

  return ForgejoApi.of({
    listPullRequests: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((locator) => {
          const apiState = input.state === "open" ? "open" : input.state === "all" ? "all" : "closed";
          // Fetch a full page (not the caller's `limit`): Forgejo can't filter by head branch,
          // so a small limit (e.g. status passes 1) would hide the branch's PR behind unrelated
          // recently-updated PRs. The caller's `limit` is applied to the filtered matches below.
          return executeJson(
            "listPullRequests",
            locator.host,
            HttpClientRequest.get(
              apiUrl(
                locator,
                `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repo)}/pulls`,
              ),
              {
                urlParams: {
                  state: apiState,
                  sort: "recentupdate",
                  limit: String(PULL_REQUEST_PAGE_SIZE),
                },
              },
            ),
            ForgejoPullRequests.ForgejoPullRequestListSchema,
          ).pipe(
            Effect.map((list) => {
              const wanted = SourceControlProvider.sourceBranch(input);
              const wantedOwner = (
                input.source?.owner ??
                SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner
              )?.toLowerCase();
              const byBranch = list
                .map(ForgejoPullRequests.normalizeForgejoPullRequestRecord)
                .filter((record) => {
                  if (record.headRefName !== wanted) return false;
                  if (wantedOwner === undefined) return true;
                  // Same-repo PRs omit the head owner, so fall back to the base repo owner.
                  const headOwner = (
                    record.headRepositoryOwnerLogin ?? locator.owner
                  ).toLowerCase();
                  return headOwner === wantedOwner;
                });
              const byState =
                input.state === "merged"
                  ? byBranch.filter((record) => record.state === "merged")
                  : input.state === "closed"
                    ? byBranch.filter((record) => record.state === "closed")
                    : byBranch;
              return input.limit !== undefined ? byState.slice(0, input.limit) : byState;
            }),
          );
        }),
      ),
    getPullRequest: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((locator) => getRawPullRequestFromLocator(locator, input.reference)),
        Effect.map(ForgejoPullRequests.normalizeForgejoPullRequestRecord),
      ),
    getRepositoryCloneUrls: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((locator) =>
          getRepositoryFromLocator(locator).pipe(
            Effect.map((raw) => normalizeRepositoryCloneUrls(raw, locator.host)),
          ),
        ),
      ),
    createRepository: (input) =>
      Effect.gen(function* () {
        const hosts = yield* keyStore.listHosts;
        const fallbackHost = hosts.length === 1 ? hosts[0]! : null;
        const locator = parseForgejoRepositorySpec(input.repository, fallbackHost);
        if (!locator) {
          return yield* new ForgejoApiError({
            operation: "createRepository",
            detail:
              hosts.length === 1
                ? "Forgejo repositories must be specified as owner/repository or host/owner/repository."
                : "Multiple Forgejo instances are configured; specify the repository as host/owner/repository.",
          });
        }
        const credential = yield* keyStore.getCredential(locator.host);
        // Route to /user/repos when creating under your own account; otherwise treat the owner as an org.
        const isOwnAccount = credential !== null && credential.name === locator.owner;
        const endpoint = isOwnAccount
          ? `/user/repos`
          : `/orgs/${encodeURIComponent(locator.owner)}/repos`;
        const raw = yield* executeJson(
          "createRepository",
          locator.host,
          HttpClientRequest.post(apiUrl(locator, endpoint)).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name: locator.repo,
              private: input.visibility === "private",
            }),
          ),
          ForgejoRepositorySchema,
        );
        return normalizeRepositoryCloneUrls(raw, locator.host);
      }),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const locator = yield* resolveRepository(input);
        const body = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoApiError({
                operation: "createPullRequest",
                detail: `Failed to read pull request body file ${input.bodyFile}.`,
                cause,
              }),
          ),
        );
        const sourceOwner =
          input.source?.owner ??
          SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
        const branch = SourceControlProvider.sourceBranch(input);
        const head = sourceOwner ? `${sourceOwner}:${branch}` : branch;
        yield* executeJson(
          "createPullRequest",
          locator.host,
          HttpClientRequest.post(
            apiUrl(
              locator,
              `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repo)}/pulls`,
            ),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              head,
              base: input.target?.refName ?? input.baseBranch,
              title: input.title,
              body,
            }),
          ),
          ForgejoPullRequests.ForgejoPullRequestSchema,
        );
      }),
    getDefaultBranch: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap(getRepositoryFromLocator),
        Effect.map((raw) => raw.default_branch?.trim() || null),
      ),
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const destination = yield* resolveRepository(input);
        const pullRequest = yield* getRawPullRequestFromLocator(destination, input.reference);
        const destinationName = `${destination.owner}/${destination.repo}`;
        const sourceName = pullRequest.head.repo?.full_name?.trim() ?? destinationName;
        const isCrossRepository = sourceName !== destinationName;
        const remoteBranch = pullRequest.head.ref;

        let remoteName: string;
        if (
          input.context?.provider.kind === "forgejo" &&
          !isCrossRepository &&
          parseForgejoRemoteUrl(input.context.remoteUrl) !== null
        ) {
          remoteName = input.context.remoteName;
        } else if (!isCrossRepository) {
          const primaryRemote = yield* git
            .resolvePrimaryRemoteName(input.cwd)
            .pipe(Effect.orElseSucceed(() => null));
          if (primaryRemote) {
            remoteName = primaryRemote;
          } else {
            const raw = yield* getRepositoryFromLocator(destination);
            const cloneUrls = normalizeRepositoryCloneUrls(raw, destination.host);
            const originRemoteUrl = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
            remoteName = yield* git.ensureRemote({
              cwd: input.cwd,
              preferredName: destination.owner,
              url: shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url,
            });
          }
        } else {
          const originRemoteUrl = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
          const httpUrl = pullRequest.head.repo?.clone_url?.trim() ?? "";
          const sshUrl = pullRequest.head.repo?.ssh_url?.trim() ?? "";
          const cloneUrl = shouldPreferSshRemote(originRemoteUrl) ? sshUrl || httpUrl : httpUrl || sshUrl;
          if (cloneUrl.length === 0) {
            return yield* new ForgejoApiError({
              operation: "checkoutPullRequest",
              detail: "Forgejo pull request head repository has no clone URL.",
            });
          }
          remoteName = yield* git.ensureRemote({
            cwd: input.cwd,
            preferredName: sourceName.split("/")[0] ?? destination.owner,
            url: cloneUrl,
          });
        }

        const localBranch = checkoutBranchName({
          pullRequestId: pullRequest.number,
          headBranch: remoteBranch,
          isCrossRepository,
        });
        const localBranchExists = (yield* git.listLocalBranchNames(input.cwd)).includes(localBranch);

        if (input.force === true || !localBranchExists) {
          yield* git.fetchRemoteBranch({ cwd: input.cwd, remoteName, remoteBranch, localBranch });
        } else {
          yield* git.fetchRemoteTrackingBranch({ cwd: input.cwd, remoteName, remoteBranch });
        }
        yield* git.setBranchUpstream({ cwd: input.cwd, branch: localBranch, remoteName, remoteBranch });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isForgejoApiError(cause)
            ? cause
            : new ForgejoApiError({
                operation: "checkoutPullRequest",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(ForgejoApi, make).pipe(Layer.provide(ForgejoKeyStore.layer));
