import { settingsSecretLiteral, SourceControlProviderKind } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { GraphQL, GraphQLResolver } from "effect/graphql";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  type ChangeRequest,
  type SourceControlProviderDiscoveryItem,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { GH_PROCESS_CONCURRENCY } from "./GitHubCredentials.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import {
  normalizeGitHubPullRequestRecord,
  type NormalizedGitHubPullRequestRecord,
} from "./gitHubPullRequests.ts";
import {
  effectiveGitHubAccount,
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
  type GitHubAuthStatusAccount,
} from "./gitHubAuthStatus.ts";
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
import { PullRequestNode, PullRequestsByHead } from "./sourceControlProvider.graphql.ts";
import { make } from "./GitHubSourceControlProvider.ts";

// Decode rows separately to isolate malformed PRs within shared documents.
export const LenientPullRequestsByHead = GraphQL.query(PullRequestsByHead.name, {
  // `GraphQLResolver.aliased` needs a template per lookup.
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

export const decodePullRequestNode = Schema.decodeUnknownOption(PullRequestNode);

export const decodeLinkSubject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ title: Schema.String, body: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

export function toChangeRequest(record: NormalizedGitHubPullRequestRecord): ChangeRequest {
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

  // gh before 2.81.0 rejects --json with a nonzero exit that resembles a signed-out CLI.
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

// `gh auth status` may not know environment tokens; check the API.
export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const process = sourceControlHost.process;
  const environment = yield* HostProcess.Environment;
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const offerAppSignIn = <A extends SourceControlProviderDiscoveryItem>(item: A): A =>
    appSignIn.enabled ? { ...item, appSignIn: true } : item;

  return {
    type: "managed-cli",
    kind: discovery.kind,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("GitHubSourceControlProvider.discovery")(function* (cwd: string) {
      const settings = readSourceControlHostSettings(
        GitHubClient.settings,
        yield* sourceControlHost.settings.getWithSecrets(GitHubClient.definition.kind).pipe(
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
      const token = settings.tokens["github.com"];
      const savedToken = settingsSecretLiteral(token).trim() !== "";
      const signedIn =
        appSignIn.enabled && !savedToken && (settings.signIns["github.com"] ?? "").trim() !== "";
      const variable = environmentTokenVariable(environment);
      const appName = GitHubClient.APP_SIGN_IN.appName;
      const tokenSource = savedToken
        ? "the token saved in Settings"
        : signedIn
          ? `the ${appName} sign-in`
          : variable;
      if (tokenSource === null || settings.hosts["github.com"]?.enabled === false) {
        return offerAppSignIn(cli);
      }
      const viewer = yield* api
        .rest({ host: "github.com", operation: "discovery", path: "user" })
        .pipe(Effect.result);
      const login = Result.isSuccess(viewer)
        ? Option.getOrUndefined(decodeViewer(viewer.success.body))?.login
        : undefined;
      const accounts = cli.auth.accounts === undefined ? {} : { accounts: cli.auth.accounts };
      return offerAppSignIn({
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
                  : signedIn
                    ? `Signed in with ${appName}.`
                    : `Using ${variable} from the server environment; it overrides the account chosen in Settings.`,
              })
            : Result.isFailure(viewer) && viewer.failure._tag !== "GitHubApiAuthenticationError"
              ? providerAuth({
                  status: "unknown",
                  host: "github.com",
                  detail: `Could not check ${savedToken || signedIn ? tokenSource : `the token in ${tokenSource}`}: ${viewer.failure.message}`,
                })
              : providerAuth({
                  status: "unauthenticated",
                  host: "github.com",
                  detail: savedToken
                    ? "GitHub refused the token saved in Settings. Replace or remove it in Settings → Source Control."
                    : signedIn
                      ? `GitHub refused the ${appName} sign-in. Sign in again in Settings → Source Control.`
                      : `GitHub refused the token in ${tokenSource}. Replace it, or unset it to use \`gh auth login\`.`,
                })),
          ...accounts,
        },
      } satisfies SourceControlProviderDiscoveryItem);
    }),
    // Claim disabled hosts so errors identify the setting.
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

export class GitHubFailure extends Data.TaggedError("GitHubFailure")<{
  readonly detail: string;
  readonly cause: unknown;
}> {}

export const failure = (detail: string, cause?: unknown) => new GitHubFailure({ detail, cause });

const PULL_REQUEST_NOT_FOUND = "Pull request not found. Check the PR number or URL and try again.";

export const REPOSITORY_NOT_FOUND = "Repository not found. Check the owner and name and try again.";

export function fromGitHubApiError(
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
    case "GitHubAppSessionError":
    case "GitHubApiResponseError":
    case "GitHubApiRequestError":
      return failure(error.message.trim() || "GitHub request failed.", error);
  }
}

export const notFound = (cause: string) => failure(PULL_REQUEST_NOT_FOUND, new Error(cause));

const RawRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  ssh_url: TrimmedNonEmptyString,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});

export const decodeRawRepository = decodeJsonResult(RawRepositorySchema);

export function repositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawRepositorySchema>,
): SourceControlRepositoryCloneUrls {
  return { nameWithOwner: raw.full_name, url: raw.html_url, sshUrl: raw.ssh_url };
}

export const decodeViewerLogin = decodeJsonResult(Schema.Struct({ login: TrimmedNonEmptyString }));

export type PullRequestListState = "open" | "closed" | "merged" | "all";

export const GRAPHQL_STATES: Record<
  PullRequestListState,
  NonNullable<PullRequestsByHead.Variables["states"]>
> = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
};

/** 50 lookups keeps responses near 0.5s at the same one-point cost as 100. */
export const HEAD_LOOKUPS_PER_DOCUMENT = 50;

/** Git reads stagger background lookups by ~300ms; gather batches before spending quota. */
export const HEAD_LOOKUP_BATCH_WINDOW = "50 millis";

export const BACKGROUND_HEAD_LOOKUP_BATCH_WINDOW = "500 millis";

/** For heads matching 100 PRs each, 50 lookups approached GitHub's ~10s limit; 25 took ~7s. */
export const BACKGROUND_HEAD_LOOKUPS_PER_DOCUMENT = 25;

export const HEAD_LOOKUP_MAX_RESPONSE_BYTES = 16_000_000;

export const OWNER_HEAD_SCAN_LIMIT = 100;

function trimmed(value: string): string | null {
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** Null isolates unusable PRs from the rest of a listing. */
export function toPullRequestRecord(node: PullRequestNode): NormalizedGitHubPullRequestRecord | null {
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
