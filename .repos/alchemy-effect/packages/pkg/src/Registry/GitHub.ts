import * as Github from "@distilled.cloud/github";
import * as Actions from "@distilled.cloud/github/actions";
import * as Apps from "@distilled.cloud/github/apps";
import * as Checks from "@distilled.cloud/github/checks";
import * as Issues from "@distilled.cloud/github/issues";
import * as Pulls from "@distilled.cloud/github/pulls";
import * as Repos from "@distilled.cloud/github/repos";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as crypto from "node:crypto";
import { COMMENT_MARKER, RegistryConfig } from "./Bindings.ts";
import * as KVCache from "./KVCache.ts";

export class CryptoError extends Data.TaggedError("CryptoError")<{
  readonly message: string;
}> {}

export class AppNotInstalled extends Data.TaggedError("AppNotInstalled")<{
  readonly repo: string;
}> {
  override get message() {
    return `The GitHub App is not installed on ${this.repo}`;
  }
}

/** Import an RSA private key PEM (PKCS#1 or PKCS#8) for RS256 signing. */
export const importPrivateKey = (pem: string) =>
  Effect.try({
    try: () => crypto.createPrivateKey({ key: pem }),
    catch: (cause) =>
      new CryptoError({ message: `invalid private key: ${cause}` }),
  });

/** Sign a compact RS256 JWT, used to authenticate as the GitHub App. */
export const signJwt = (
  claims: Record<string, unknown>,
  key: crypto.KeyObject,
) =>
  Effect.try({
    try: () => {
      const header = Encoding.encodeBase64Url(
        JSON.stringify({ alg: "RS256", typ: "JWT" }),
      );
      const payload = Encoding.encodeBase64Url(JSON.stringify(claims));
      const input = `${header}.${payload}`;
      const signature = crypto.sign("sha256", Buffer.from(input), key);
      return `${input}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
    },
    catch: (cause) => new CryptoError({ message: `signing failed: ${cause}` }),
  });

/**
 * Install commands per package, grouped. A group marked `collapsed`
 * renders as a closed `<details>` block so a long list of secondary
 * packages stays out of the way.
 */
export const renderInstalls = (
  packages: ReadonlyArray<{ name: string; group: string; url: string }>,
  groups: ReadonlyArray<{ name: string; collapsed: boolean }>,
) => {
  const collapsed = new Set(
    groups.filter((g) => g.collapsed).map((g) => g.name),
  );
  // One code block per package so each command has its own copy button, in
  // the order the manifest lists them, which is the order they were given
  // to `pkg pack`. Blank lines around the markdown inside `<details>` are
  // what make GitHub render it.
  return Object.entries(Arr.groupBy(packages, (pkg) => pkg.group))
    .flatMap(([group, members]) => {
      const installs = members.flatMap(({ url }) => [
        "```sh",
        `pnpm install ${url}`,
        "```",
        "",
      ]);
      return collapsed.has(group)
        ? [
            "<details>",
            `<summary><b>${group}</b> (${members.length})</summary>`,
            "",
            ...installs,
            "</details>",
            "",
          ]
        : [`### ${group}`, "", ...installs];
    })
    .join("\n");
};

/**
 * GitHub's `<relative-time>` element, rendered as a live relative time in
 * comments, with a plain UTC fallback like `Sep 7, 2026 at 2:42 PM UTC`.
 */
const relativeTime = (millis: number) => {
  const date = DateTime.makeUnsafe(millis);
  const label = DateTime.formatUtc(date, {
    locale: "en-US",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `<relative-time datetime="${DateTime.formatIso(date)}">${label} UTC</relative-time>`;
};

export const renderComment = (
  packages: ReadonlyArray<{ name: string; group: string; url: string }>,
  groups: ReadonlyArray<{ name: string; collapsed: boolean }>,
  times: { readonly publishedAt: number; readonly expiresAt: number },
) =>
  [
    COMMENT_MARKER,
    "",
    "Install the packages built from this commit:",
    "",
    renderInstalls(packages, groups),
    `Published ${relativeTime(times.publishedAt)}. Expires ${relativeTime(times.expiresAt)}, extended while this pull request is open.`,
  ].join("\n");

/** Render any GitHub operation failure for logs and error responses. */
export const describe = (error: {
  readonly _tag: string;
  readonly message?: string | undefined;
}) => (error.message ? `${error._tag}: ${error.message}` : error._tag);

const USER_AGENT = "alchemy-pkg";

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  return { owner: owner ?? "", repo: name ?? "" };
};

/**
 * Installation tokens are refreshed two minutes before GitHub expires them:
 * one for clock skew, one for the minute KV's edge cache may keep serving an
 * expired entry.
 */
const TOKEN_MARGIN = Duration.minutes(2);

/**
 * The registry's GitHub App: every operation runs as the App's installation
 * on the repository in question. Installation tokens live in the KV cache,
 * so one mint per repository serves every isolate for about an hour.
 */
const make = Effect.gen(function* () {
  const config = yield* RegistryConfig;
  const http = yield* HttpClient.HttpClient;

  /** Run a distilled GitHub operation as the given bearer token. */
  const as = <A, E, R>(token: string, operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.provideService(
        Github.Credentials,
        Effect.succeed({
          token: Redacted.make(token),
          apiBaseUrl: config.github.apiUrl,
          userAgent: USER_AGENT,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, http),
    );

  // The credentials are read here, when a token is minted, never during the
  // Worker's Init: `Registry.ts` binds them explicitly, so plan time never
  // resolves them. Importing the key is a sub-millisecond step next to the
  // two GitHub calls a mint makes, so nothing is kept between mints.
  const appJwt = Effect.gen(function* () {
    const pem = yield* config.github.privateKey;
    const key = yield* importPrivateKey(Redacted.value(pem));
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return yield* signJwt(
      { iat: now - 60, exp: now + 540, iss: yield* config.github.appId },
      key,
    );
  });

  // Failures are not kept: the next call retries the mint.
  const tokens = KVCache.make(
    (repo: string) => `token:${repo}`,
    Schema.String,
    (repo) =>
      Effect.gen(function* () {
        const jwt = yield* appJwt;
        const installation = yield* as(
          jwt,
          Apps.getRepoInstallation(split(repo)),
        ).pipe(
          Effect.catchTag("NotFound", () => new AppNotInstalled({ repo })),
        );
        const access = yield* as(
          jwt,
          Apps.createInstallationAccessToken({
            installation_id: installation.id,
          }),
        );
        const now = yield* Clock.currentTimeMillis;
        return {
          value: access.token,
          ttl: Duration.subtract(
            Duration.millis(Math.max(0, Date.parse(access.expires_at) - now)),
            TOKEN_MARGIN,
          ),
        };
      }),
  );

  /** A GitHub operation run as the App's installation on `repo`. */
  const asInstallation = <A, E, R>(
    repo: string,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.flatMap(tokens(repo), (token) => as(token, operation));

  return {
    getRun: (repo: string, runId: number) =>
      asInstallation(
        repo,
        Actions.getWorkflowRun({ ...split(repo), run_id: runId }),
      ),

    /**
     * Artifacts named `name` uploaded to a run so far, including by jobs
     * still in progress.
     */
    listRunArtifacts: (repo: string, runId: number, name: string) =>
      asInstallation(
        repo,
        Actions.listWorkflowRunArtifacts({
          ...split(repo),
          run_id: runId,
          name,
          per_page: 100,
        }),
      ).pipe(Effect.map((page) => page.artifacts)),

    /**
     * Pull requests against `repo` whose head is `sha` in `headRepo`, the
     * repository the commit was pushed to.
     */
    pullRequestsForCommit: (repo: string, headRepo: string, sha: string) =>
      asInstallation(
        repo,
        Repos.listPullRequestsAssociatedWithCommit({
          ...split(repo),
          commit_sha: sha,
          per_page: 100,
        }),
      ).pipe(
        Effect.map((pulls) =>
          pulls.filter(
            (pr) =>
              pr.head.sha === sha &&
              pr.head.repo?.full_name === headRepo &&
              pr.base.repo.full_name === repo,
          ),
        ),
      ),

    getPullRequest: (repo: string, number: number) =>
      asInstallation(repo, Pulls.get({ ...split(repo), pull_number: number })),

    /**
     * Publish a completed check run on `headSha`. GitHub shows the newest run
     * per name and App, so re-publishing the same commit simply supersedes it.
     */
    createCheckRun: (
      repo: string,
      input: {
        readonly headSha: string;
        readonly name: string;
        readonly title: string;
        readonly summary: string;
        readonly detailsUrl: string;
      },
    ) =>
      Effect.flatMap(DateTime.now, (now) =>
        asInstallation(
          repo,
          Checks.create({
            ...split(repo),
            name: input.name,
            head_sha: input.headSha,
            status: "completed",
            conclusion: "success",
            completed_at: DateTime.formatIso(now),
            details_url: input.detailsUrl,
            output: { title: input.title, summary: input.summary },
          }),
        ),
      ),

    /**
     * Create or update the comment on `issue` whose body starts with
     * `marker`, looking through the first five pages of comments.
     */
    upsertComment: (
      repo: string,
      issue: number,
      marker: string,
      body: string,
    ) =>
      Effect.gen(function* () {
        const comments = Stream.paginate(1, (page) =>
          asInstallation(
            repo,
            Issues.listComments({
              ...split(repo),
              issue_number: issue,
              per_page: 100,
              page,
            }),
          ).pipe(
            Effect.map((comments) => [
              comments,
              comments.length < 100 || page >= 5
                ? Option.none()
                : Option.some(page + 1),
            ]),
          ),
        );
        const existing = yield* comments.pipe(
          Stream.filter((comment) => comment.body?.startsWith(marker) === true),
          Stream.take(1),
          Stream.runCollect,
          Effect.map(Arr.head),
        );
        yield* Option.match(existing, {
          onNone: () =>
            asInstallation(
              repo,
              Issues.createComment({
                ...split(repo),
                issue_number: issue,
                body,
              }),
            ),
          onSome: (comment) =>
            asInstallation(
              repo,
              Issues.updateComment({
                ...split(repo),
                comment_id: comment.id,
                body,
              }),
            ),
        });
      }),
  };
});

export class GitHubApp extends Context.Service<
  GitHubApp,
  Effect.Success<typeof make>
>()("@alchemy.run/pkg/GitHubApp") {}

export const GitHubAppLive = Layer.effect(GitHubApp, make);
