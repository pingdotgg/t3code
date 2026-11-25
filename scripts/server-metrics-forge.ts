// A fake GitHub Enterprise host for the server-metrics soak: the GitHub API the server polls for a
// web client, and a git remote it fetches from, both over HTTPS on loopback. client-metrics also
// gives the branch PR a body, files, commits and comments, so its panel renders real content.
// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer takes a node:http2 server; the proxy is raw.
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  PullRequestListInput,
  PullRequestListResult,
  PullRequestRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { run, ScenarioError } from "./scenarios/shell.ts";

const OWNER = "bench";
const REPO = "project";
const TOKEN = "ghp_bench_fake";
/**
 * The host the project's origin names. It carries no port because pull request listings key a
 * GitHub host without one, so the server reaches it on 443 through a proxy that tunnels it here.
 */
const HOST = "bench.test";

export interface ForgeRequest {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  /** The GraphQL operation name, for GraphQL requests. */
  readonly operation: string | undefined;
  readonly status: number;
}

const GraphQlRequest = Schema.Struct({
  query: Schema.optional(Schema.String),
  operationName: Schema.optional(Schema.NullOr(Schema.String)),
  variables: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
const decodeGraphQl = Schema.decodeUnknownEffect(Schema.fromJsonString(GraphQlRequest));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);
/** FNV-1a, enough to tell bodies apart. */
const hash = (text: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return value.toString(16);
};

interface Failure {
  readonly message: string;
}

interface FakePullRequest {
  readonly number: number;
  readonly head: string;
  oid: string;
}

export interface FakePullRequestFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** A unified diff hunk, as GitHub's REST files list returns it. */
  readonly patch: string;
}

/** What the branch PR shows when its panel opens; without it, those reads answer 404. */
export interface FakePullRequestDetail {
  readonly body: string;
  readonly files: ReadonlyArray<FakePullRequestFile>;
  readonly comments: ReadonlyArray<string>;
  readonly commits: number;
}

/** Serves the fake host until the scope closes. */
export const serveFakeGitHub = Effect.fn("serverMetrics.serveFakeGitHub")(function* (
  options: { readonly detail?: FakePullRequestDetail } = {},
) {
  const detail = options.detail;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-metrics-forge-" });
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  yield* run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=${HOST}`,
    "-addext",
    `subjectAltName=DNS:${HOST}`,
    "-keyout",
    keyFile,
    "-out",
    certFile,
  ]);
  const bare = path.join(dir, `${REPO}.git`);
  yield* run("git", ["init", "-q", "--bare", bare]);
  const requests: ForgeRequest[] = [];
  const host = HOST;
  const pullRequests: Array<FakePullRequest> = [
    { number: 1, head: "bench/feature", oid: "0".repeat(40) },
    ...[2, 3, 4, 5].map((number) => ({
      number,
      head: `bench/other-${number}`,
      oid: "0".repeat(40),
    })),
  ];

  const actor = { __typename: "User", id: "U_bench", login: OWNER, name: "Bench", avatarUrl: "" };
  /** Every field any of the polled reads selects; decoders ignore the ones a read did not ask for. */
  const pullRequestNode = (pr: FakePullRequest, now: number) => {
    const minute = Math.floor(now / 60_000);
    const at = (offsetMinutes: number) =>
      DateTime.formatIso(DateTime.makeUnsafe((minute - offsetMinutes) * 60_000));
    // The branch PR's CI reruns every other minute, so checks and their rollup keep changing.
    const running = pr.number === 1 && minute % 2 === 0;
    const detailed = pr.number === 1 ? detail : undefined;
    return {
      __typename: "PullRequest",
      id: `PR_bench_${pr.number}`,
      number: pr.number,
      title: `Bench change ${pr.number}`,
      url: `https://${host}/${OWNER}/${REPO}/pull/${pr.number}`,
      body: detailed?.body ?? "A pull request the soak polls.",
      baseRefName: "main",
      headRefName: pr.head,
      headRefOid: pr.oid,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: running ? "BLOCKED" : "CLEAN",
      reviewDecision: null,
      additions: detailed ? sum(detailed.files.map((file) => file.additions)) : 1,
      deletions: detailed ? sum(detailed.files.map((file) => file.deletions)) : 0,
      changedFiles: detailed?.files.length ?? 1,
      createdAt: at(600 + pr.number),
      updatedAt: at(0),
      mergedAt: null,
      mergeCommit: null,
      mergedBy: null,
      closedAt: null,
      isCrossRepository: false,
      maintainerCanModify: false,
      headRepository: { name: REPO, nameWithOwner: `${OWNER}/${REPO}`, viewerPermission: "ADMIN" },
      headRepositoryOwner: { __typename: "User", login: OWNER },
      headRef: { id: `REF_bench_${pr.number}` },
      repository: { nameWithOwner: `${OWNER}/${REPO}` },
      author: actor,
      autoMergeRequest: null,
      viewerCanUpdate: true,
      viewerDidAuthor: true,
      viewerCanUpdateBranch: false,
      baseRef: { compare: { behindBy: 0 } },
      reviewRequests: { nodes: [] },
      latestReviews: { nodes: [] },
      labels: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: running ? "PENDING" : "SUCCESS",
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "test",
                      status: running ? "IN_PROGRESS" : "COMPLETED",
                      conclusion: running ? null : "SUCCESS",
                      startedAt: at(1),
                      completedAt: running ? null : at(0),
                      detailsUrl: `https://${host}/${OWNER}/${REPO}/actions/runs/${minute}`,
                      checkSuite: {
                        workflowRun: {
                          event: "pull_request",
                          runNumber: minute,
                          workflow: { id: "W_bench", name: "CI" },
                        },
                      },
                    },
                    {
                      __typename: "StatusContext",
                      context: "lint",
                      state: "SUCCESS",
                      targetUrl: null,
                      createdAt: at(5),
                      description: "Lint passed",
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        ],
      },
    };
  };
  const repositorySettings = {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    autoMergeAllowed: false,
    viewerPermission: "ADMIN",
  };
  const page = <A>(nodes: ReadonlyArray<A>) => ({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes,
  });
  /** The detailed PR's activity: commits, comments and one approving review. */
  const activity = (pr: FakePullRequest, now: number, value: FakePullRequestDetail) => {
    const at = (offsetMinutes: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(now - offsetMinutes * 60_000));
    const url = `https://${host}/${OWNER}/${REPO}/pull/${pr.number}`;
    return {
      author: actor,
      commits: {
        nodes: Array.from({ length: value.commits }, (_, index) => ({
          commit: {
            id: `C_bench_${index}`,
            oid: index === value.commits - 1 ? pr.oid : index.toString(16).padStart(40, "a"),
            messageHeadline: `Bench commit ${index + 1}: move the next helper`,
            committedDate: at(500 - index),
            parents: { totalCount: 1 },
            authors: {
              nodes: [{ name: "Bench", email: "bench@t3.codes", user: { login: OWNER } }],
            },
          },
        })),
      },
      comments: page(
        value.comments.map((body, index) => ({
          id: `IC_bench_${index}`,
          body,
          createdAt: at(400 - index),
          lastEditedAt: null,
          url: `${url}#issuecomment-${index}`,
          isMinimized: false,
          author: actor,
        })),
      ),
      reviews: page([
        {
          id: "PRR_bench_0",
          body: "Looks good once the last helper moves.",
          state: "APPROVED",
          submittedAt: at(10),
          lastEditedAt: null,
          url: `${url}#pullrequestreview-0`,
          isMinimized: false,
          author: actor,
        },
      ]),
    };
  };

  /** The `data` of a GraphQL answer, each aliased slice (`_0_repository`) answered on its own. */
  const answer = (
    operation: string,
    variables: Readonly<Record<string, unknown>>,
    now: number,
  ): Record<string, unknown> | undefined => {
    const prefixes = new Set(
      Object.keys(variables).map((name) => /^(_\d+_)?/.exec(name)?.[1] ?? ""),
    );
    if (prefixes.size === 0) prefixes.add("");
    const data: Record<string, unknown> = {};
    for (const prefix of prefixes) {
      const variable = (name: string) => variables[`${prefix}${name}`];
      const byNumber = pullRequests.find((pr) => pr.number === variable("number"));
      const single = byNumber === undefined ? null : pullRequestNode(byNumber, now);
      const all = pullRequests.map((pr) => pullRequestNode(pr, now));
      switch (operation) {
        case "PullRequestsByHead":
        case "PullRequestHeads":
          data[`${prefix}repository`] = {
            pullRequests: page(all.filter((pr) => pr.headRefName === variable("head"))),
          };
          break;
        case "PullRequestList":
          data[`${prefix}repository`] = { pullRequests: page(all) };
          break;
        case "PullRequestSearch":
          data[`${prefix}search`] = page(all);
          break;
        case "PullRequestByNumber":
        case "PullRequestSummary":
        case "PullRequestStats":
        case "PullRequestCheckContexts":
          data[`${prefix}repository`] = { pullRequest: single };
          break;
        case "PullRequestCore":
          data[`${prefix}repository`] = { ...repositorySettings, pullRequest: single };
          break;
        case "PullRequestActivity":
          if (detail === undefined || byNumber?.number !== 1) return undefined;
          data[`${prefix}repository`] = { pullRequest: activity(byNumber, now, detail) };
          break;
        case "PullRequestFileStats":
        case "PullRequestFilesViewed":
          if (detail === undefined || byNumber?.number !== 1) return undefined;
          data[`${prefix}repository`] = {
            pullRequest: {
              files: page(
                detail.files.map((file) => ({
                  path: file.path,
                  additions: file.additions,
                  deletions: file.deletions,
                  viewerViewedState: "UNVIEWED",
                })),
              ),
            },
          };
          break;
        case "RoutingIdentityViewer":
          data[`${prefix}viewer`] = { databaseId: 1, login: OWNER };
          break;
        case "ActorAvatars": {
          const ids = variable("ids");
          data[`${prefix}nodes`] = (Array.isArray(ids) ? ids : []).map(() => actor);
          break;
        }
        default:
          return undefined;
      }
    }
    return data;
  };

  /** REST answers by path under /api/v3; the body moves each minute where real polling sees change. */
  const restAnswer = (path: string, search: URLSearchParams, now: number): unknown => {
    const minute = Math.floor(now / 60_000);
    const repository = `repos/${OWNER}/${REPO}`;
    if (path === "user")
      return { login: OWNER, id: 1, name: "Bench", avatar_url: "", type: "User" };
    if (path === repository) {
      return {
        id: 1,
        node_id: "R_bench",
        name: REPO,
        full_name: `${OWNER}/${REPO}`,
        private: false,
        default_branch: "main",
        html_url: `https://${host}/${OWNER}/${REPO}`,
        owner: { login: OWNER, id: 1, type: "User" },
        permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      };
    }
    const branchPullRequest = pullRequests[0];
    if (detail !== undefined && branchPullRequest !== undefined) {
      if (path === `${repository}/pulls/1`) {
        return {
          number: 1,
          base: { sha: publishedMain ?? "0".repeat(40), ref: "main" },
          head: { sha: branchPullRequest.oid, ref: branchPullRequest.head },
        };
      }
      if (path === `${repository}/pulls/1/files`) {
        // One page holds every file; the next page ends the listing.
        if (Number(search.get("page") ?? "1") > 1) return [];
        return detail.files.map((file) => ({
          filename: file.path,
          status: "modified",
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          patch: file.patch,
        }));
      }
    }
    if (path === `${repository}/actions/runs`) {
      return {
        total_count: minute % 2 === 0 ? 1 : 0,
        workflow_runs:
          minute % 2 === 0
            ? [
                {
                  id: minute,
                  name: "CI",
                  html_url: `https://${host}/${OWNER}/${REPO}/actions/runs/${minute}`,
                  status: "in_progress",
                },
              ]
            : [],
      };
    }
    return undefined;
  };

  const serveGit = Effect.fn("serverMetrics.fakeGitHub.git")(function* (relative: string) {
    if (relative.split("/").includes("..")) return HttpServerResponse.empty({ status: 404 });
    const file = path.join(bare, relative);
    const body = yield* fs.readFile(file).pipe(Effect.option);
    return body._tag === "Some"
      ? HttpServerResponse.uint8Array(body.value, { contentType: "application/octet-stream" })
      : HttpServerResponse.empty({ status: 404 });
  });

  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "https://127.0.0.1");
    const gitPrefix = `/${OWNER}/${REPO}.git/`;
    let operation: string | undefined;
    let response: HttpServerResponse.HttpServerResponse;
    if (url.pathname.startsWith(gitPrefix)) {
      // Dumb HTTP: a static info/refs makes git fall back to reading the bare repository's files.
      response = yield* serveGit(url.pathname.slice(gitPrefix.length));
    } else if (url.pathname === "/api/graphql") {
      const raw = yield* request.text;
      const body = yield* decodeGraphQl(raw).pipe(
        Effect.orElseSucceed((): typeof GraphQlRequest.Type => ({})),
      );
      operation =
        body.operationName ??
        /\b(?:query|mutation)\s+(\w+)/.exec(body.query ?? "")?.[1] ??
        "anonymous";
      const data = answer(operation, body.variables ?? {}, yield* Clock.currentTimeMillis);
      response =
        data === undefined
          ? HttpServerResponse.jsonUnsafe({ message: "Not Found" }, { status: 404 })
          : HttpServerResponse.jsonUnsafe({ data });
    } else if (
      detail !== undefined &&
      url.pathname === `/api/v3/repos/${OWNER}/${REPO}/pulls/1` &&
      (request.headers.accept ?? "").includes("application/vnd.github.diff")
    ) {
      // GitHub refuses large diffs with 406, which sends the provider to the paged files list.
      response = HttpServerResponse.jsonUnsafe(
        { message: "Sorry, the diff exceeded the maximum number of files (300)." },
        { status: 406 },
      );
    } else {
      const body = url.pathname.startsWith("/api/v3/")
        ? restAnswer(
            url.pathname.slice("/api/v3/".length),
            url.searchParams,
            yield* Clock.currentTimeMillis,
          )
        : undefined;
      if (body === undefined) {
        response = HttpServerResponse.jsonUnsafe(
          { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
          { status: 404 },
        );
      } else {
        // A weak validator of the body, so an unchanged answer revalidates as a 304.
        const text = encodeJson(body);
        const etag = `W/"${text.length.toString(16)}-${hash(text)}"`;
        response =
          request.headers["if-none-match"] === etag
            ? HttpServerResponse.empty({ status: 304, headers: { etag } })
            : HttpServerResponse.text(text, {
                contentType: "application/json",
                headers: { etag },
              });
      }
    }
    requests.push({
      at: yield* Clock.currentTimeMillis,
      method: request.method,
      path: url.pathname + url.search,
      operation,
      status: response.status,
    });
    return response;
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })));

  const key = yield* fs.readFileString(keyFile);
  const cert = yield* fs.readFileString(certFile);
  const context = yield* Layer.build(
    NodeHttpServer.layer(() => NodeHttp2.createSecureServer({ key, cert, allowHTTP1: true }), {
      port: 0,
      host: "127.0.0.1",
    }),
  );
  const port = yield* Effect.gen(function* () {
    yield* HttpServer.serveEffect(Effect.interruptible(app));
    const { address } = yield* HttpServer.HttpServer;
    return address._tag === "UnixPathAddress" ? 0 : address.port;
  }).pipe(Effect.provide(context));
  // Tunnels only the fake host, so nothing the server sends through it reaches the internet.
  const tunnels = new Set<NodeNet.Socket>();
  const proxy = NodeHttp.createServer((_request, response) => {
    response.writeHead(405).end();
  });
  proxy.on("connect", (request: NodeHttp.IncomingMessage, client: NodeNet.Socket) => {
    if (request.url !== `${HOST}:443`) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = NodeNet.connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      tunnels.add(socket);
      socket.on("close", () => tunnels.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
  });
  const proxyPort = yield* Effect.acquireRelease(
    Effect.callback<number, ScenarioError>((resume) => {
      proxy.once("error", (error) =>
        resume(
          Effect.fail(new ScenarioError({ message: `the fake GitHub proxy: ${error.message}` })),
        ),
      );
      proxy.listen(0, "127.0.0.1", () => {
        const address = proxy.address();
        resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0));
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const socket of tunnels) socket.destroy();
        proxy.closeAllConnections();
        proxy.close(() => resume(Effect.void));
      }),
  );
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  /** Publishes the project to the fake remote and checks out a branch with an open PR. */
  const setupProject = Effect.fn("serverMetrics.fakeGitHub.setupProject")(function* (
    project: string,
  ) {
    const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: project });
    yield* git(["switch", "-q", "-c", "bench/feature"]);
    yield* fs.writeFileString(path.join(project, "FEATURE.md"), "# feature\n");
    yield* git(["add", "."]);
    yield* git([
      "-c",
      "user.email=bench@t3.codes",
      "-c",
      "user.name=bench",
      "commit",
      "-qm",
      "feature",
    ]);
    yield* git(["push", "-q", bare, "main", "bench/feature"]);
    yield* run("git", ["--git-dir", bare, "update-server-info"]);
    yield* git(["remote", "add", "origin", `https://${host}/${OWNER}/${REPO}.git`]);
    yield* git(["config", "http.sslCAInfo", certFile]);
    yield* git(["config", "http.proxy", proxyUrl]);
    // A developer's NO_PROXY could send this past the proxy, which is the only route to the host.
    const hostEnvironment = yield* HostProcess.Environment;
    yield* run("git", ["fetch", "-q", "origin"], {
      cwd: project,
      env: {
        ...Object.fromEntries(
          Object.entries(hostEnvironment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        NO_PROXY: "",
        no_proxy: "",
        GIT_SSL_CAINFO: certFile,
      },
    });
    yield* git(["branch", "-q", "--set-upstream-to", "origin/bench/feature"]);
    const [feature, main] = (yield* git(["rev-parse", "HEAD", "main"])).stdout.trim().split("\n");
    for (const pr of pullRequests) pr.oid = (pr.number === 1 ? feature : main) ?? pr.oid;
    setupRequests = requests.length;
    publishedMain = main;
  });

  let pushes = 0;
  /** Lands a commit on the remote's main, so the server's next fetch transfers something. */
  const advanceRemote = Effect.gen(function* () {
    const git = (args: ReadonlyArray<string>) => run("git", ["--git-dir", bare, ...args]);
    const commit = (yield* git([
      "-c",
      "user.email=bench@t3.codes",
      "-c",
      "user.name=bench",
      "commit-tree",
      "main^{tree}",
      "-p",
      "main",
      "-m",
      `upstream ${++pushes}`,
    ])).stdout.trim();
    yield* git(["update-ref", "refs/heads/main", commit]);
    yield* git(["update-server-info"]);
  });

  /** Requests the project setup made before the server started, which `verify` leaves out. */
  let setupRequests = 0;
  let publishedMain: string | undefined;
  let fetchedPush = false;
  let completedPolls = 0;
  const failures: Array<string> = [];
  /**
   * What a web client with the pull requests sidebar and the branch's PR open asks for: the list,
   * then the branch PR's summary and checks, every 30 s until interrupted. Failures are kept, not
   * thrown, so one bad answer does not end the soak.
   */
  const pollLikeWebClient = Effect.fn("serverMetrics.fakeGitHub.poll")(function* (rpc: {
    readonly list: (input: PullRequestListInput) => Effect.Effect<PullRequestListResult, Failure>;
    readonly summary: (input: PullRequestRef) => Effect.Effect<unknown, Failure>;
    readonly checks: (input: PullRequestRef) => Effect.Effect<unknown, Failure>;
  }) {
    const record = (what: string) => (error: Failure) =>
      Effect.sync(() => {
        failures.push(`${what}: ${error.message}`);
      });
    while (true) {
      const listed = yield* rpc
        .list({ state: "open" })
        .pipe(Effect.tapError(record("pullRequests.list")), Effect.option);
      const entry =
        listed._tag === "Some"
          ? listed.value.entries.find((row) => row.headBranch === "bench/feature")
          : undefined;
      if (listed._tag === "Some" && entry === undefined) {
        failures.push(`pullRequests.list: no branch PR in ${listed.value.entries.length} rows`);
      }
      if (entry !== undefined) {
        const ref = {
          projectId: entry.projectId,
          host: entry.host,
          repository: entry.repository,
          number: entry.number,
        };
        const completed = yield* Effect.all([rpc.summary(ref), rpc.checks(ref)]).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            record("pullRequests.summary/checks")(error).pipe(Effect.as(false)),
          ),
        );
        if (completed) completedPolls++;
      }
      yield* Effect.sleep(Duration.seconds(30));
    }
  });

  return {
    host,
    /** The server's view of the host: the fake token and CA, and none of the developer's logins. */
    env: {
      GH_HOST: host,
      GH_ENTERPRISE_TOKEN: TOKEN,
      GITHUB_ENTERPRISE_TOKEN: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      // An empty gh config, so a gh the server runs has no login for any host.
      GH_CONFIG_DIR: path.join(dir, "gh"),
      NODE_EXTRA_CA_CERTS: certFile,
      // Overrides a developer's own GIT_SSL_CAINFO, which would win over the repository's setting.
      GIT_SSL_CAINFO: certFile,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      // The fake Anthropic API and the server's own loopback listeners stay direct.
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    },
    setupProject,
    advanceRemote,
    /** Records whether the project's origin/main moved past setup, i.e. the server fetched a push. */
    checkFetched: (project: string) =>
      run("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: project }).pipe(
        Effect.map(({ stdout }) => {
          fetchedPush = stdout.trim() !== publishedMain;
        }),
      ),
    requests: requests as ReadonlyArray<ForgeRequest>,
    pollLikeWebClient,
    /**
     * Prints what the server asked for, and fails unless it polled pull requests and checks and
     * fetched from the remote. Poller failures are reported, not fatal: a long soak can see one.
     */
    verify: Effect.gen(function* () {
      const counts = new Map<string, number>();
      for (const request of requests.slice(setupRequests)) {
        const key =
          request.operation ??
          (request.path.startsWith(`/${OWNER}/${REPO}.git/`)
            ? request.status !== 200
              ? undefined
              : request.path.startsWith(`/${OWNER}/${REPO}.git/info/refs`)
                ? "git fetch"
                : undefined
            : `${request.method} ${request.path.replace(/\?.*/, "")} ${request.status}`);
        if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const listed = [...counts].map(([key, count]) => `${key} ×${count}`).join(", ");
      yield* Console.error(`fake GitHub served ${requests.length} requests: ${listed}`);
      if (failures.length > 0) {
        yield* Console.error(
          `fake GitHub: ${failures.length} client polls failed, first: ${failures[0]}`,
        );
      }
      const missing = [
        "PullRequestsByHead",
        "PullRequestSearch",
        "PullRequestCore",
        "git fetch",
      ].filter((key) => !counts.has(key));
      if (pushes > 0 && !fetchedPush) missing.push("a fetch that brought in a pushed commit");
      if (completedPolls === 0) missing.push("one full client poll (list, summary, checks)");
      if (missing.length > 0) {
        return yield* new ScenarioError({
          message: `the soak never reached the fake GitHub for ${missing.join(", ")}`,
        });
      }
    }),
  };
});

export type FakeGitHub = Effect.Success<ReturnType<typeof serveFakeGitHub>>;
