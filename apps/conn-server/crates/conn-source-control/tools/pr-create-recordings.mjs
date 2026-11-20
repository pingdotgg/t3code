// T3's `GitManager.createPullRequest` (the `pull_request_create` tool's flow) on real git
// checkouts and an in-memory GitHub. Each case sets up a checkout with plain `git` commands,
// answers GitHub's requests from its own table, and records every request, the draft calls on
// `PullRequestService`, and the result or the error. The Rust test runs the same setup and
// answers, and must send the same requests and return the same result.
//
// The remotes name github.com, but nothing is fetched or pushed: the remote-tracking refs are
// written by hand, and `GIT_ALLOW_PROTOCOL=file` stops any git child that would reach a host.
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { importSource, packageImporter } from "../../../tools/monorepo.mjs";

const server = packageImporter("apps/server");
const pkg = packageImporter("packages/source-control-github");

// Each step is a git argv, or `{ write: [path, text] }`.
const base = (branch = "feature/x") => [
  ["init", "-q", "-b", "main"],
  ["config", "user.name", "Fixture"],
  ["config", "user.email", "fixture@example.com"],
  ["config", "commit.gpgsign", "false"],
  // T3 fetches the upstream before it reads the status; no fixture may reach a host.
  ["config", "protocol.allow", "never"],
  { write: ["README.md", "fixture\n"] },
  ["add", "README.md"],
  ["commit", "-q", "-m", "Initial"],
  ["remote", "add", "origin", "https://github.com/acme/web.git"],
  ["update-ref", "refs/remotes/origin/main", "HEAD"],
  ["checkout", "-q", "-b", branch],
  { write: ["feature.txt", "feature\n"] },
  ["add", "feature.txt"],
  ["commit", "-q", "-m", "Feature"],
];
const pushed = (branch = "feature/x", remote = "origin", remoteBranch = branch) => [
  ["update-ref", `refs/remotes/${remote}/${remoteBranch}`, "HEAD"],
  ["config", `branch.${branch}.remote`, remote],
  ["config", `branch.${branch}.merge`, `refs/heads/${remoteBranch}`],
];
const node = (fields = {}) => ({
  number: 7, title: "Feature", url: "https://github.com/acme/web/pull/7", baseRefName: "main",
  headRefName: "feature/x", headRefOid: "abc", state: "OPEN", isDraft: false, mergedAt: null,
  closedAt: null, updatedAt: "2026-11-20T00:00:00Z", isCrossRepository: false,
  headRepository: { name: "web", nameWithOwner: "acme/web" }, headRepositoryOwner: { __typename: "Organization", login: "acme" },
  ...fields,
});
const heads = (...answers) => ({ "graphql PullRequestsByHead": answers });
const repository = { status: 200, body: { default_branch: "main", full_name: "acme/web" } };
const created = { status: 201, body: { number: 7 } };
const input = (fields = {}) => ({ title: "Feature", body: "Body text\n", ...fields });

export const CASES = [
  { name: "created", setup: [...base(), ...pushed()], input: input(),
    responses: { ...heads([], [node()]), "GET /repos/acme/web": [repository], "POST /repos/acme/web/pulls": [created] } },
  { name: "created, not listed yet", setup: [...base(), ...pushed()], input: input(),
    responses: { ...heads([], []), "GET /repos/acme/web": [repository], "POST /repos/acme/web/pulls": [created] } },
  { name: "open already", setup: [...base(), ...pushed()], input: input(),
    responses: heads([node({ number: 5, url: "https://github.com/acme/web/pull/5", title: "Older" })]) },
  { name: "other head repository is not ours", setup: [...base(), ...pushed()], input: input(),
    responses: { ...heads([node({ number: 3, isCrossRepository: true, headRepository: { name: "web", nameWithOwner: "other/web" }, headRepositoryOwner: { __typename: "User", login: "other" } })], [node()]),
      "GET /repos/acme/web": [repository], "POST /repos/acme/web/pulls": [created] } },
  { name: "explicit base", setup: [...base(), ...pushed()], input: input({ base: "develop" }),
    responses: { ...heads([], [node({ baseRefName: "develop" })]), "POST /repos/acme/web/pulls": [created] } },
  { name: "recorded gh base", setup: [...base(), ...pushed(), ["branch", "release"], ["config", "branch.feature/x.gh-merge-base", "release"]], input: input(),
    responses: { ...heads([], [node({ baseRefName: "release" })]), "POST /repos/acme/web/pulls": [created] } },
  { name: "recorded t3 base ref", setup: [...base(), ...pushed(), ["update-ref", "refs/remotes/origin/stable", "HEAD~1"], ["config", "branch.feature/x.t3-merge-base-ref", "refs/remotes/origin/stable"]], input: input(),
    responses: { ...heads([], [node({ baseRefName: "stable" })]), "POST /repos/acme/web/pulls": [created] } },
  { name: "upstream under another name", setup: [...base("feat"), ...pushed("feat", "origin", "feature/x")], input: input(),
    responses: { ...heads([], [node()]), "POST /repos/acme/web/pulls": [created] } },
  { name: "repository unreadable", setup: [...base(), ...pushed(), ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]], input: input(),
    responses: { ...heads([], [node()]), "GET /repos/acme/web": [{ status: 404, body: { message: "Not Found" } }], "POST /repos/acme/web/pulls": [created] } },
  { name: "fork remote", setup: [...base(), ["remote", "add", "fork", "https://github.com/me/web.git"], ...pushed("feature/x", "fork")], input: input(),
    responses: { ...heads([node({ number: 4, isCrossRepository: false })], [node({ number: 9, url: "https://github.com/acme/web/pull/9", isCrossRepository: true, headRepository: { name: "web", nameWithOwner: "me/web" }, headRepositoryOwner: { __typename: "User", login: "me" } })]),
      "GET /repos/acme/web": [repository], "POST /repos/acme/web/pulls": [created] } },
  { name: "host refuses", setup: [...base(), ...pushed()], input: input(),
    responses: { ...heads([]), "GET /repos/acme/web": [repository], "POST /repos/acme/web/pulls": [{ status: 422, body: { message: "Validation Failed", errors: [{ message: "No commits between main and feature/x" }] } }] } },
  { name: "unpushed commit", setup: [...base(), ...pushed(), { write: ["late.txt", "late\n"] }, ["add", "late.txt"], ["commit", "-q", "-m", "Late"]], input: input(),
    responses: heads([]) },
  { name: "not pushed", setup: base(), input: input(), responses: {} },
  { name: "detached", setup: [...base(), ["checkout", "-q", "--detach"]], input: input(), responses: {} },
  { name: "draft, created", setup: [...base(), ...pushed()], input: input({ draft: true }),
    responses: { ...heads([], [node()]), "GET /repos/acme/web": [repository], "POST /repos/acme/web/pulls": [created] } },
  { name: "draft, open and ready", setup: [...base(), ...pushed()], input: input({ draft: true }), summary: { isDraft: false },
    responses: heads([node()]) },
  { name: "draft, open and draft", setup: [...base(), ...pushed()], input: input({ draft: true }), summary: { isDraft: true },
    responses: heads([node({ isDraft: true })]) },
  { name: "draft, not listed yet", setup: [...base(), ...pushed()], input: input({ draft: true }),
    responses: { ...heads([], []), "GET /repos/acme/web": [repository], "POST /repos/acme/web/pulls": [created] } },
  { name: "draft fails", setup: [...base(), ...pushed()], input: input({ draft: true }), summary: { isDraft: false }, draftFails: "No permission",
    responses: heads([node()]) },
];

/** Runs a case's setup in `dir`, as the Rust test does. */
export function setUp(dir, steps) {
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_DATE: "2026-11-20T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-20T00:00:00Z" };
  for (const step of steps) {
    if (!Array.isArray(step)) { NodeFS.writeFileSync(NodePath.join(dir, step.write[0]), step.write[1]); continue; }
    NodeChild.execFileSync("git", step, { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
  }
}

export async function recordCreatePullRequests() {
  // No git child may reach a host, and none reads the machine's git settings.
  process.env.GIT_ALLOW_PROTOCOL = "file";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  const [Effect, Layer, Redacted, References] = await Promise.all([pkg("effect/Effect"), pkg("effect/Layer"), pkg("effect/Redacted"), pkg("effect/References")]);
  const { HttpClient, HttpClientResponse } = await pkg("effect/http");
  const NodeServices = await server("@effect/platform-node/NodeServices");
  const NodeCrypto = await server("@effect/platform-node/NodeCrypto");
  const gh = (name) => importSource(`packages/source-control-github/src/server/${name}.ts`);
  const app = (name) => importSource(`apps/server/src/${name}.ts`);
  const [Provider, Rest, Credentials, AppSignIn, Quota, Limits, Host, HostProcess] = await Promise.all([
    gh("GitHubSourceControlProvider"), gh("GitHubRest"), gh("GitHubCredentials"), gh("GitHubAppSignIn"), gh("GitHubQuota"),
    importSource("packages/source-control-core/src/server/SourceControlRateLimit.ts"),
    importSource("packages/source-control-testing/src/TestSourceControlHost.ts"),
    importSource("packages/shared/src/HostProcess.ts"),
  ]);
  const [GitManager, GitVcsDriver, VcsProcess, Registry, ServerConfig, ProjectionStore, ProjectStore, PullRequestService, Sqlite, SetupRunner, ProviderRegistry, ServerSettings, TextGeneration] = await Promise.all([
    app("git/GitManager"), app("vcs/GitVcsDriver"), app("vcs/VcsProcess"), app("sourceControl/SourceControlProviderRegistry"),
    app("config"), app("orchestration-v2/ProjectionStore"), app("orchestration-v2/ProjectStore"), app("pullRequest/PullRequestService"),
    app("persistence/Sqlite"), app("project/ProjectSetupScriptRunner"), app("provider/ProviderRegistry"), app("serverSettings"),
    app("textGeneration/TextGeneration"),
  ]);
  const { ProjectId } = await importSource("packages/contracts/src/baseSchemas.ts");
  const out = [];
  for (const entry of CASES) {
    const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-pr-create-")));
    try {
      setUp(dir, entry.setup);
      const requests = [];
      const served = {};
      const http = HttpClient.make((request) => Effect.sync(() => {
        const url = new URL(request.url);
        const path = url.pathname + url.search;
        const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null;
        const operation = path.endsWith("/graphql") ? /^(?:query|mutation) (\w+)/.exec(body.query)?.[1] : undefined;
        requests.push({ method: request.method, path, body });
        const key = operation === undefined ? `${request.method} ${path}` : `graphql ${operation}`;
        const turn = served[key] ?? 0;
        served[key] = turn + 1;
        const answers = entry.responses[key];
        const answer = answers?.[Math.min(turn, answers.length - 1)];
        let status = 200;
        let json;
        if (operation === "PullRequestsByHead") {
          // One aliased lookup per document: `_0_repository`.
          json = { data: Object.fromEntries(Object.keys(body.variables).filter((k) => k.endsWith("_owner")).map((k) => [`${k.slice(0, -"owner".length)}repository`, { pullRequests: { nodes: answer ?? [] } }])) };
        } else if (answer === undefined) {
          status = 404; json = { message: "Not Found" };
        } else { status = answer.status; json = answer.body; }
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }));
      }));
      const httpLayer = Layer.succeed(HttpClient.HttpClient, http);
      const credentials = Layer.succeed(Credentials.GitHubCredentials, {
        get: (host) => Effect.succeed({ host, token: Redacted.make("fake-pr-token"), source: "gh", fingerprint: "fixture" }),
        saved: () => Effect.succeedNone, fingerprint: () => Effect.succeed("fixture"), invalidate: () => Effect.void,
      });
      const signedOut = Layer.mock(AppSignIn.GitHubAppSignIn)({ enabled: false, token: () => Effect.succeedNone, invalidate: () => Effect.void });
      const gitRuns = (input) => Effect.sync(() => {
        const result = NodeChild.spawnSync(input.command, input.args, { cwd: input.cwd, encoding: "utf8", env: process.env });
        if (result.status !== 0 && !input.allowNonZeroExit) throw new Error(`${input.command} ${input.args.join(" ")} failed`);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1, stdoutTruncated: false, stderrTruncated: false };
      });
      const githubLayer = Layer.mergeAll(
        Rest.layer.pipe(Layer.provideMerge(Layer.mergeAll(credentials, httpLayer, signedOut)), Layer.provideMerge(Quota.layer), Layer.provideMerge(Limits.layer)),
        Host.layer({ process: { run: gitRuns } }),
        httpLayer,
        NodeServices.layer,
        Layer.succeed(HostProcess.Environment, {}),
      );
      const provider = await Effect.runPromise(Effect.scoped(Provider.make.pipe(Effect.provide(githubLayer))).pipe(Effect.orDie));
      const draftCalls = [];
      const registry = Layer.succeed(Registry.SourceControlProviderRegistry, Registry.SourceControlProviderRegistry.of({
        resolveLink: () => undefined,
        get: () => Effect.succeed(provider),
        resolveHandle: () => Effect.succeed({ provider, context: null }),
        resolve: () => Effect.succeed(provider),
        discover: Effect.succeed([]),
      }));
      const vcs = GitVcsDriver.layer.pipe(
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provideMerge(ServerConfig.layerTest(dir, { prefix: "conn-pr-create-t3-" })),
      );
      const managerLayer = Layer.mergeAll(
        Layer.succeed(TextGeneration.TextGeneration, {}),
        Layer.mock(PullRequestService.PullRequestService)({
          summary: (ref) => Effect.sync(() => { draftCalls.push({ call: "summary", ref }); return { isDraft: entry.summary?.isDraft ?? false }; }),
          runAction: (action) => entry.draftFails === undefined
            ? Effect.sync(() => void draftCalls.push({ call: "runAction", action }))
            : Effect.sync(() => draftCalls.push({ call: "runAction", action })).pipe(Effect.andThen(Effect.fail(new Error(entry.draftFails)))),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.succeed(SetupRunner.ProjectSetupScriptRunner, { runForThread: () => Effect.succeed({ status: "no-script" }) }),
        ServerSettings.ServerSettingsService.layerTest(),
      ).pipe(Layer.provideMerge(registry), Layer.provideMerge(vcs), Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
      const stores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(Layer.provideMerge(Sqlite.layerMemory));
      const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const manager = yield* GitManager.make.pipe(Effect.provide(managerLayer));
        return yield* Effect.result(manager.createPullRequest({
          cwd: dir, projectId: ProjectId.make("project-1"), title: entry.input.title, body: entry.input.body,
          ...(entry.input.base === undefined ? {} : { baseBranch: entry.input.base }),
          ...(entry.input.draft === undefined ? {} : { draft: entry.input.draft }),
        }));
      }).pipe(Effect.provide(stores), Effect.provideService(References.MinimumLogLevel, "None"))));
      out.push({
        name: entry.name, setup: entry.setup, input: entry.input, responses: entry.responses,
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        ...(entry.draftFails === undefined ? {} : { draftFails: entry.draftFails }),
        requests, draftCalls,
        ...(outcome._tag === "Success" ? { result: outcome.success } : { error: { tag: outcome.failure._tag, message: outcome.failure.message } }),
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}

