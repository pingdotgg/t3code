import { assert, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsIssueTracker from "@t3tools/source-control-azure-devops/server/AzureDevOpsIssueTracker";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import {
  IssueTrackerKind,
  ProjectId,
  issueListCursorKey,
  type OrchestrationProjectShell,
  type Project,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as LinearApi from "@t3tools/issue-tracker-linear/server/LinearApi";
import * as JiraApi from "@t3tools/issue-tracker-jira/server/JiraApi";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as Schema from "effect/Schema";
import * as LinearIssueTracker from "@t3tools/issue-tracker-linear/server/LinearIssueTracker";
import type { StandaloneIssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as IssueTrackerAccounts from "../persistence/IssueTrackerAccounts.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";
import * as IssueTrackerHostLive from "./IssueTrackerHostLive.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const LINEAR = IssueTrackerKind.make("linear");
const JIRA = IssueTrackerKind.make("jira");
const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
const shell = (id: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/w/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
});
const nativeUser = (id: string) => ({
  id,
  name: id,
  displayName: id,
  email: `${id}@example.test`,
  avatarUrl: null,
});
const nativeIssue = (account: string) => ({
  id: `issue-${account}`,
  identifier: "ENG-7",
  number: 7,
  title: account,
  url: "https://linear.app/acme/issue/ENG-7",
  description: "body",
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  completedAt: null,
  canceledAt: null,
  state: { id: "open", name: "Todo", type: "unstarted", position: 0 },
  creator: nativeUser(account),
  assignee: nativeUser(account),
  team: { key: "ENG", states: empty },
  projectMilestone: null,
  labels: empty,
  comments: empty,
  history: empty,
  attachments: empty,
  reactions: [],
});

const azureFixture = (sources: ReadonlyArray<{ id: string; host: string; repository: string }>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const identities: Array<{ cwd: string; organization: string }> = [];
    const requests: Array<{ cwd: string; organization: string; resource: string; body: unknown }> =
      [];
    const projects = sources.map((source) => ({
      ...shell(source.id),
      repositoryIdentity: {
        canonicalKey: source.host + "/" + source.repository,
        provider: "azure-devops" as const,
        displayName: source.repository,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://" + source.host + "/" + source.repository,
        },
      },
    }));
    const api = yield* AzureDevOpsIssueTracker.make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
          getCurrentIdentity: (input) =>
            Effect.sync(() => {
              identities.push(input);
              const url = new URL(input.organization);
              return (url.pathname.slice(1) || url.hostname.split(".")[0]) + "@fake.test";
            }),
          execute: ({ cwd, args }) =>
            Effect.gen(function* () {
              const organization = args[args.indexOf("--organization") + 1]!;
              const resource = args[args.indexOf("--resource") + 1]!;
              const body = args.includes("--in-file")
                ? JSON.parse(
                    yield* fs
                      .readFileString(args[args.indexOf("--in-file") + 1]!)
                      .pipe(Effect.orDie),
                  )
                : null;
              requests.push({ cwd, organization, resource, body });
              if (resource === "wiql")
                return TestSourceControlHost.processOutput(
                  JSON.stringify({ workItems: [{ id: 7 }] }),
                );
              if (resource !== "workitemsbatch")
                return yield* Effect.die("Unexpected Azure request " + resource);
              assert.deepEqual(body.ids, [7]);
              const url = new URL(organization);
              const account = (url.pathname.slice(1) || url.hostname.split(".")[0]) + "@fake.test";
              return TestSourceControlHost.processOutput(
                JSON.stringify({
                  count: 1,
                  value: [
                    {
                      id: 7,
                      url: organization + "/_apis/wit/workItems/7",
                      fields: {
                        "System.Title": account,
                        "System.State": "Active",
                        "System.CreatedDate": "2026-10-15T00:00:00Z",
                        "System.ChangedDate": "2026-10-15T00:00:00Z",
                        "System.TeamProject": args
                          .find((arg) => arg.startsWith("project="))!
                          .slice(8),
                        "System.CreatedBy": { uniqueName: account },
                        "System.AssignedTo": { uniqueName: account },
                      },
                    },
                  ],
                }),
              );
            }),
        }),
      ),
    );
    const service = yield* IssueService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
            list: Effect.succeed(new Map()),
          }),
          Layer.succeed(
            IssueTrackerRegistry.IssueTrackerRegistry,
            IssueTrackerRegistry.fromTrackers([api]),
          ),
          Layer.mock(ProjectService.ProjectService)({
            listShells: () => Effect.succeed(projects),
            getShell: (id) =>
              Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === id))),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: (cwd) =>
              Effect.succeed(
                projects.find((project) => project.workspaceRoot === cwd)?.repositoryIdentity ??
                  null,
              ),
          }),
        ),
      ),
    );
    return { service, identities, requests };
  }).pipe(Effect.provide(NodeFileSystem.layer));

it.effect(
  "keeps Azure organization actors apart and reuses one principal read for each organization",
  () =>
    Effect.gen(function* () {
      const f = yield* azureFixture([
        { id: "alpha", host: "dev.azure.com", repository: "alpha/Web App/_git/one" },
        { id: "worktree", host: "dev.azure.com", repository: "alpha/Web App/_git/one" },
        { id: "api", host: "dev.azure.com", repository: "alpha/API/_git/two" },
        { id: "beta", host: "dev.azure.com", repository: "beta/Web App/_git/three" },
      ]);
      const result = yield* f.service.list({ state: "all", involvement: "assigned" });
      assert.isEmpty(result.errors);
      assert.equal(result.entries.length, 3);
      assert.deepEqual(f.identities.map((read) => read.organization).sort(), [
        "https://dev.azure.com/alpha",
        "https://dev.azure.com/beta",
      ]);
      assert.deepEqual(result.viewers, {
        "azure-devops dev.azure.com alpha/Web App": "alpha@fake.test",
        "azure-devops dev.azure.com alpha/API": "alpha@fake.test",
        "azure-devops dev.azure.com beta/Web App": "beta@fake.test",
      });
      for (const entry of result.entries)
        assert.equal(entry.author?.login, entry.scope.split("/")[0] + "@fake.test");
      const wiql = f.requests.filter((request) => request.resource === "wiql");
      assert.equal(wiql.length, 3);
      for (const request of wiql)
        assert.include(JSON.stringify(request.body), "[System.AssignedTo] = @Me");
      assert.isFalse(f.requests.some((request) => request.resource === "profiles"));
    }),
);

it.effect(
  "reads an external Azure organization through a lending checkout with the target principal",
  () =>
    Effect.gen(function* () {
      const f = yield* azureFixture([
        { id: "alpha", host: "dev.azure.com", repository: "alpha/Web/_git/one" },
      ]);
      const result = yield* f.service.list({
        projectId: ProjectId.make("alpha"),
        tracker: IssueTrackerKind.make("azure-devops"),
        host: "dev.azure.com",
        scope: "beta/Web",
        state: "all",
        involvement: "authored",
      });
      assert.isEmpty(result.errors);
      assert.deepEqual(f.identities, [
        { cwd: "/w/alpha", organization: "https://dev.azure.com/beta" },
      ]);
      assert.equal(result.entries[0]?.author?.login, "beta@fake.test");
      assert.equal(result.viewers["azure-devops dev.azure.com beta/web"], "beta@fake.test");
      assert.equal(f.requests.filter((request) => request.resource === "wiql").length, 1);
      assert.include(JSON.stringify(f.requests[0]?.body), "[System.CreatedBy] = @Me");
    }),
);

it.effect.each(["legacy.visualstudio.com", "legacy.visualstudio.com:443"] as const)(
  "resolves legacy Azure %s and an encoded project without changing the principal",
  (host) =>
    Effect.gen(function* () {
      const f = yield* azureFixture([{ id: "legacy", host, repository: "Web%20App/_git/one" }]);
      const result = yield* f.service.list({ state: "all" });
      assert.isEmpty(result.errors);
      assert.deepEqual(f.identities, [
        { cwd: "/w/legacy", organization: "https://legacy.visualstudio.com" },
      ]);
      assert.equal(result.entries[0]?.host, host);
      assert.equal(result.entries[0]?.scope, "legacy/Web App");
      assert.equal(result.entries[0]?.author?.login, "legacy@fake.test");
    }),
);

it.effect("refuses a nonstandard Azure port before account discovery and work item reads", () =>
  Effect.gen(function* () {
    const f = yield* azureFixture([
      {
        id: "legacy",
        host: "legacy.visualstudio.com:8443",
        repository: "Web/_git/one",
      },
    ]);
    const result = yield* f.service.list({ state: "all" });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.host, "legacy.visualstudio.com:8443");
    assert.isEmpty(f.identities);
    assert.isEmpty(f.requests);
  }),
);

const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const stored = new Map<string, Uint8Array>();
  const credentialWrites: Array<"set" | "create" | "remove"> = [];
  const requests: Array<{ token: string; operation: string; variables: Record<string, unknown> }> =
    [];
  const writes: Array<{ token: string; issueId: unknown }> = [];
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let holdA = false;
  let failToken: string | undefined;
  let failRollback = false;
  let serial = 0;
  const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
    set: (name, bytes) =>
      Effect.gen(function* () {
        credentialWrites.push("set");
        const token = new TextDecoder().decode(bytes);
        if (!(failRollback && token === "token-A")) stored.set(name, bytes);
        if (token === failToken || (failRollback && token === "token-A"))
          return yield* new ServerSecretStore.SecretStorePersistError({
            resource: "fake",
            cause: "fake write failed",
          });
      }),
    create: (name, bytes) =>
      Effect.sync(() => {
        credentialWrites.push("create");
        assert.isFalse(stored.has(name));
        stored.set(name, bytes);
      }),
    remove: (name) =>
      Effect.sync(() => {
        credentialWrites.push("remove");
        stored.delete(name);
      }),
  });
  const crypto = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(++serial),
      digest: (_algorithm, data) => Effect.succeed(data),
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const token = request.headers.authorization ?? "";
        const account = token.replace("token-", "").replace("-rotated", "");
        const body = request.body;
        assert.equal(body._tag, "Uint8Array");
        if (body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON body");
        const parsed = JSON.parse(new TextDecoder().decode(body.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        const operation = /^(?:query|mutation) (\w+)/.exec(parsed.query)?.[1] ?? "?";
        requests.push({ token, operation, variables: parsed.variables });
        const organization = { id: `org-${account}`, urlKey: "acme", templates: empty };
        let data: unknown;
        switch (operation) {
          case "T3ProbeCredential":
            data = {
              organization,
              viewer: nativeUser(account),
              teams: {
                ...empty,
                nodes: [{ id: `team-${account}`, key: "ENG", name: "Engineering" }],
              },
            };
            break;
          case "T3Viewer":
            data = { viewer: nativeUser(account) };
            break;
          case "T3Issues":
            data = {
              organization,
              viewer: nativeUser(account),
              issues: { ...empty, nodes: [nativeIssue(account)] },
            };
            break;
          case "T3Issue":
            data = { issue: nativeIssue(account) };
            break;
          case "T3IssueReference":
            if (holdA && token === "token-A") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            data = { issue: nativeIssue(account) };
            break;
          case "T3IssueUpdate":
            writes.push({ token, issueId: parsed.variables.id });
            data = { issueUpdate: { success: true } };
            break;
          default:
            return yield* Effect.die(`Unexpected native operation ${operation}`);
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ data }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  const dependencies = Layer.mergeAll(secrets, crypto, http, RateLimit.layer);
  const linear = yield* LinearIssueTracker.make.pipe(
    Effect.provide(
      LinearApi.layer.pipe(
        Layer.provide(
          Layer.merge(dependencies, IssueTrackerHostLive.layer.pipe(Layer.provide(secrets))),
        ),
      ),
    ),
  );
  const jira: StandaloneIssueTrackerApi = {
    ...linear,
    kind: JIRA,
    standalone: {
      ...linear.standalone,
      tracker: JIRA,
      displayName: "Jira",
      host: "jira.example.test",
    },
    probeCredential: (token) =>
      Effect.succeed({
        account: "jira-user",
        accountId: "jira-user",
        host: token.startsWith("dc-")
          ? `JIRA.EXAMPLE:8443/${token.includes("lower") ? "jira" : "Jira"}`
          : "jira.example.test",
        scopes: [{ key: "OPS", name: "Operations" }],
      }),
  };
  const projects = [shell("A"), shell("B"), shell("default"), shell("alias")];
  const projectLayer = Layer.mock(ProjectService.ProjectService)({
    listShells: () => Effect.succeed(projects),
    getShell: (id) => Effect.succeed(Option.fromNullishOr(projects.find((p) => p.id === id))),
    getById: (id) =>
      Effect.succeed(
        Option.fromNullishOr(projects.find((p) => p.id === id)).pipe(
          Option.map((p): Project => ({ ...p, deletedAt: null })),
        ),
      ),
  });
  const base = Layer.mergeAll(
    dependencies,
    projectLayer,
    IssueTrackerBindings.layer,
    IssueTrackerAccounts.layer,
    Layer.succeed(
      IssueTrackerRegistry.IssueTrackerRegistry,
      IssueTrackerRegistry.fromTrackers([linear, jira]),
    ),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  );
  const connections = yield* IssueTrackerConnections.IssueTrackerConnections.pipe(
    Effect.provide(IssueTrackerConnections.layer.pipe(Layer.provide(base))),
  );
  const service = yield* IssueService.make.pipe(Effect.provide(base));
  const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository.pipe(
    Effect.provide(IssueTrackerBindings.layer),
  );
  const accounts = yield* IssueTrackerAccounts.IssueTrackerAccountsRepository.pipe(
    Effect.provide(IssueTrackerAccounts.layer),
  );
  const add = (token: string) =>
    connections.connect({ tracker: LINEAR, addAccount: true, token: { value: token } });
  const bind = (projectId: string, connectionId?: string) =>
    connections.bindProject({
      projectId: ProjectId.make(projectId),
      tracker: LINEAR,
      binding: {
        value: {
          tracker: LINEAR,
          scope: "acme/ENG",
          ...(connectionId === undefined ? {} : { connectionId }),
        },
      },
    });
  const ref = (projectId: string, connectionId?: string) => ({
    projectId: ProjectId.make(projectId),
    tracker: LINEAR,
    host: "linear.app",
    scope: "acme/ENG",
    key: "ENG-7",
    ...(connectionId === undefined ? {} : { connectionId }),
  });
  return {
    connections,
    service,
    bindings,
    accounts,
    stored,
    credentialWrites,
    requests,
    writes,
    add,
    bind,
    ref,
    entered,
    release,
    hold: () => {
      holdA = true;
    },
    fail: (token?: string, rollback = false) => {
      failToken = token;
      failRollback = rollback;
    },
  };
});

it.effect(
  "rejects repeated native account additions before writes while retaining rotation and the default",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.connections.connect({ tracker: LINEAR, token: "token-default" });
      yield* f.bind("default");
      const added = yield* f.add("token-A");
      yield* f.bind("A", added.connectionId);
      const accounts = yield* f.accounts.list;
      const bindings = yield* f.bindings.list;
      const stored = new Map(f.stored);
      f.requests.length = 0;
      f.credentialWrites.length = 0;
      const repeated = yield* Effect.all(
        ["token-A", "token-A-rotated"].map((token) => f.add(token).pipe(Effect.result)),
        { concurrency: 2 },
      );
      for (const result of repeated) {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "rejected");
      }
      assert.deepEqual(
        f.requests.map((request) => request.operation),
        ["T3ProbeCredential", "T3ProbeCredential"],
      );
      assert.deepEqual(f.credentialWrites, []);
      assert.deepEqual(f.stored, stored);
      assert.deepEqual(yield* f.accounts.list, accounts);
      assert.deepEqual(yield* f.bindings.list, bindings);
      f.requests.length = 0;
      const rotated = yield* f.connections.connect({
        tracker: LINEAR,
        connectionId: added.connectionId,
        token: { value: "token-A-rotated" },
      });
      assert.equal(rotated.connectionId, added.connectionId);
      assert.deepEqual(f.credentialWrites, ["set"]);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(yield* f.accounts.list, accounts);
      assert.deepEqual(yield* f.bindings.list, bindings);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps distinct and case-exact native accounts separate on the same host", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const added = yield* Effect.forEach(["token-A", "token-a", "token-B"], f.add);
    assert.equal(new Set(added.map((account) => account.connectionId)).size, 3);
    assert.deepEqual(
      (yield* f.accounts.list).map((account) => account.accountId).sort(),
      ["org-A/A", "org-a/a", "org-B/B"].sort(),
    );
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.credentialWrites, ["create", "create", "create"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([
  { tracker: LINEAR, host: "other.linear.test" },
  { tracker: JIRA, host: "linear.app" },
])("does not merge native identity across tracker/host %j", (previous) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.accounts.set({ ...previous, connectionId: "existing", accountId: "org-A/A" });
    const added = yield* f.add("token-A");
    assert.isDefined(added.connectionId);
    assert.notEqual(added.connectionId, "existing");
    assert.lengthOf(yield* f.accounts.list, 2);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.credentialWrites, ["create"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "routes same-host same-team same-key native reads and interleaved preflight/writes by selected account",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.add("token-A");
      const b = yield* f.add("token-B");
      assert.isDefined(a.connectionId);
      assert.isDefined(b.connectionId);
      assert.notEqual(a.connectionId, b.connectionId);
      f.requests.length = 0;
      const catalog = yield* f.connections.list;
      assert.deepEqual(
        catalog.accounts?.map((account) => account.connectionId).sort(),
        [a.connectionId, b.connectionId].sort(),
      );
      assert.equal(f.requests.length, 2);

      yield* f.bind("A", a.connectionId);
      yield* f.bind("B", b.connectionId);
      yield* f.bind("alias", a.connectionId);
      f.requests.length = 0;
      const page = yield* f.service.list({ state: "all", involvement: "assigned" });
      assert.equal(f.requests.length, 4);
      assert.deepEqual(
        page.entries.map((entry) => [entry.connectionId, entry.title]).sort(),
        [
          [a.connectionId, "A"],
          [b.connectionId, "B"],
        ].sort(),
      );
      assert.deepEqual(page.viewers, {
        [issueListCursorKey(f.ref("A", a.connectionId))]: "A",
        [issueListCursorKey(f.ref("B", b.connectionId))]: "B",
      });
      for (const request of f.requests.filter((request) => request.operation === "T3Issues"))
        assert.deepEqual(request.variables.filter, {
          team: { key: { eq: "ENG" } },
          assignee: { id: { eq: request.token.slice(6) } },
        });
      f.requests.length = 0;
      const details = yield* Effect.all(
        [
          f.service.detail(f.ref("A", a.connectionId)),
          f.service.detail(f.ref("B", b.connectionId)),
        ],
        { concurrency: 2 },
      );
      assert.deepEqual(
        details.map((detail) => [detail.connectionId, detail.title]),
        [
          [a.connectionId, "A"],
          [b.connectionId, "B"],
        ],
      );
      assert.equal(f.requests.length, 4);
      f.requests.length = 0;
      f.hold();
      const first = yield* f.service
        .update({ ...f.ref("A", a.connectionId), title: "A edit" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      yield* f.service.update({ ...f.ref("B", b.connectionId), title: "B edit" });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(first);
      assert.deepEqual(f.writes, [
        { token: "token-B", issueId: "issue-B" },
        { token: "token-A", issueId: "issue-A" },
      ]);
      assert.equal(f.requests.length, 4);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "rejects stale and missing account selectors before native I/O and never lends legacy cursors",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.add("token-A");
      const b = yield* f.add("token-B");
      yield* f.bind("A", a.connectionId);
      yield* f.bind("A", b.connectionId);
      f.requests.length = 0;
      for (const ref of [
        f.ref("A", a.connectionId),
        f.ref("A"),
        f.ref("A", "missing"),
        { ...f.ref("A", b.connectionId), host: "foreign.test" },
        { ...f.ref("A", b.connectionId), scope: "other/ENG" },
      ]) {
        yield* f.service.detail(ref).pipe(Effect.flip);
        yield* f.service.update({ ...ref, title: "must not write" }).pipe(Effect.flip);
      }
      yield* f.service
        .resolveUrl("https://linear.app/acme/issue/ENG-7", ProjectId.make("A"), a.connectionId)
        .pipe(Effect.flip);
      assert.equal(
        (yield* f.service.resolveUrl("https://linear.app/acme/issue/ENG-7", ProjectId.make("A")))
          .connectionId,
        b.connectionId,
      );
      const page = yield* f.service.list({
        state: "all",
        cursors: { "linear.app acme/ENG": "old-default-cursor" },
      });
      assert.deepEqual(page.entries, []);
      assert.equal(f.requests.length, 0);
      assert.equal(f.writes.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "discovers URL accounts from the current project and refuses ambiguous account lookup",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.add("token-A");
      const b = yield* f.add("token-B");
      yield* f.bind("A", a.connectionId);
      yield* f.bind("alias", a.connectionId);
      const url = "https://linear.app/acme/issue/ENG-7";
      f.requests.length = 0;
      assert.equal((yield* f.service.resolveUrl(url)).connectionId, a.connectionId);
      yield* f.bind("B", b.connectionId);
      yield* f.connections.connect({ tracker: LINEAR, token: "token-default" });
      yield* f.bind("default");
      f.requests.length = 0;
      assert.equal(
        (yield* f.service.resolveUrl(url, ProjectId.make("B"))).connectionId,
        b.connectionId,
      );
      assert.equal(
        (yield* f.service.resolveUrl(url, undefined, a.connectionId)).connectionId,
        a.connectionId,
      );
      yield* f.service.resolveUrl(url).pipe(Effect.flip);
      yield* f.service.resolveUrl(url, ProjectId.make("B"), a.connectionId).pipe(Effect.flip);
      yield* f.service.resolveUrl(url, undefined, "missing").pipe(Effect.flip);
      assert.equal(f.requests.length, 0);
      const selected = yield* f.service.resolveUrl(url, ProjectId.make("B"));
      assert.equal((yield* f.service.detail(selected)).title, "B");
      assert.equal(f.requests.length, 2);
      assert.isTrue(f.requests.every((request) => request.token === "token-B"));
      yield* f.bind("B", a.connectionId);
      f.requests.length = 0;
      assert.equal(
        (yield* f.service.resolveUrl(url, ProjectId.make("B"))).connectionId,
        a.connectionId,
      );
      yield* f.service.resolveUrl(url, ProjectId.make("B"), b.connectionId).pipe(Effect.flip);
      assert.equal(f.requests.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "keeps selected-account rotation, disconnect, two tracker bindings and legacy default operations isolated",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.add("token-A");
      const b = yield* f.add("token-B");
      yield* f.bind("A", a.connectionId);
      yield* f.bind("B", b.connectionId);
      yield* f.connections.connect({ tracker: JIRA, token: "jira-token" });
      yield* f.connections.bindProject({
        projectId: ProjectId.make("A"),
        binding: { tracker: JIRA, scope: "OPS" },
      });
      assert.equal((yield* f.bindings.list).get(ProjectId.make("A"))?.length, 2);
      assert.deepEqual(
        (yield* f.service.sources(ProjectId.make("A"))).map((source) => [
          source.tracker,
          source.connectionId,
        ]),
        [
          [JIRA, undefined],
          [LINEAR, a.connectionId],
        ],
      );
      assert.equal(
        (yield* f.service.listSources({
          projectId: ProjectId.make("A"),
          connectionId: a.connectionId,
        })).length,
        1,
      );
      yield* f.connections
        .bindProject({ projectId: ProjectId.make("A"), binding: null })
        .pipe(Effect.flip);
      yield* f.connections
        .bindProject({
          projectId: ProjectId.make("A"),
          tracker: LINEAR,
          connectionId: b.connectionId,
          binding: { value: null },
        })
        .pipe(Effect.flip);
      f.requests.length = 0;
      yield* f.connections
        .connect({ tracker: LINEAR, connectionId: a.connectionId, token: { value: "token-B" } })
        .pipe(Effect.flip);
      assert.equal(f.requests.length, 1);
      yield* f.connections.connect({
        tracker: LINEAR,
        connectionId: a.connectionId,
        token: { value: "token-A-rotated" },
      });
      f.requests.length = 0;
      assert.equal((yield* f.service.detail(f.ref("A", a.connectionId))).title, "A");
      assert.equal(f.requests.length, 2);
      f.requests.length = 0;
      yield* f.connections.connect({ tracker: LINEAR, token: "token-default" });
      assert.equal(f.requests.length, 1);
      yield* f.bind("default");
      f.requests.length = 0;
      yield* f.service.list({ projectId: ProjectId.make("default"), state: "all" });
      assert.equal(f.requests.length, 2);
      f.requests.length = 0;
      yield* f.service.detail(f.ref("default"));
      assert.equal(f.requests.length, 2);
      f.requests.length = 0;
      yield* f.connections.connect({ tracker: LINEAR, token: "token-new-default" });
      assert.equal(f.requests.length, 2);
      assert.deepEqual((yield* f.bindings.list).get(ProjectId.make("default")), undefined);
      yield* f.connections.connect({ tracker: LINEAR, token: null });
      yield* f.connections.connect({
        tracker: LINEAR,
        connectionId: a.connectionId,
        token: { value: null },
      });
      const remaining = yield* f.bindings.list;
      assert.deepEqual(remaining.get(ProjectId.make("A")), [
        { tracker: JIRA, scope: "OPS", host: "jira.example.test" },
      ]);
      assert.equal(remaining.get(ProjectId.make("B"))?.[0]?.connectionId, b.connectionId);
      f.requests.length = 0;
      assert.equal((yield* f.service.detail(f.ref("B", b.connectionId))).title, "B");
      assert.equal(f.requests.length, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "rejects unwrapped account and tracker selectors without any native or persistence mutation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const input of [
        { tracker: LINEAR, token: "token-A", addAccount: true },
        { tracker: LINEAR, token: null, connectionId: "A" },
      ])
        yield* f.connections.connect(input).pipe(Effect.flip);
      yield* f.connections
        .bindProject({ projectId: ProjectId.make("A"), tracker: LINEAR, binding: null })
        .pipe(Effect.flip);
      assert.equal(f.requests.length, 0);
      assert.equal(f.stored.size, 0);
      assert.equal((yield* f.bindings.list).size, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([false, true])(
  "recovers a selected failed token write without touching another account, rollback failure %s",
  (rollback) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.add("token-A");
      const b = yield* f.add("token-B");
      yield* f.bind("A", a.connectionId);
      yield* f.bind("B", b.connectionId);
      f.fail("token-A-rotated", rollback);
      yield* f.connections
        .connect({
          tracker: LINEAR,
          connectionId: a.connectionId,
          token: { value: "token-A-rotated" },
        })
        .pipe(Effect.flip);
      const bindings = yield* f.bindings.list;
      assert.equal(bindings.get(ProjectId.make("B"))?.[0]?.connectionId, b.connectionId);
      assert.equal(bindings.has(ProjectId.make("A")), !rollback);
      f.requests.length = 0;
      assert.equal((yield* f.service.detail(f.ref("B", b.connectionId))).title, "B");
      assert.equal(f.requests.length, 2);
      if (!rollback)
        assert.equal(
          new TextDecoder().decode(
            f.stored.get(IssueTrackerHostLive.issueTrackerSecretName(LINEAR, a.connectionId)),
          ),
          "token-A",
        );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "isolates native Jira HTTP credential contexts on the same site and rejects foreign hosts without a request",
  () =>
    Effect.gen(function* () {
      const seen: Array<{ authorization: string | undefined; url: string; method: string }> = [];
      const secrets = new Map<string, Uint8Array>();
      for (const connectionId of [undefined, "Account", "account"])
        secrets.set(
          IssueTrackerHostLive.issueTrackerSecretName(JIRA, connectionId),
          new TextEncoder().encode(
            JSON.stringify({
              site: "same.atlassian.net",
              email: `${connectionId ?? "default"}@example.test`,
              token: `fake-${connectionId ?? "default"}`,
            }),
          ),
        );
      const stores = Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
      });
      const dependencies = Layer.mergeAll(
        IssueTrackerHostLive.layer.pipe(Layer.provide(stores)),
        RateLimit.layer,
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              seen.push({
                authorization: request.headers.authorization,
                url: request.url,
                method: request.method,
              });
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ key: "OPS-7" }), {
                  headers: { "content-type": "application/json" },
                }),
              );
            }),
          ),
        ),
      );
      const api = yield* JiraApi.make.pipe(Effect.provide(dependencies));
      for (const method of ["GET", "PUT"] as const) {
        yield* Effect.all(
          [undefined, "Account", "account"].map((connectionId) =>
            api
              .request({
                host: "same.atlassian.net",
                operation: "account-test",
                method,
                path: "/issue/OPS-7",
                schema: Schema.Struct({ key: Schema.String }),
              })
              .pipe(Effect.provideService(IssueTrackerHost.ConnectionId, connectionId)),
          ),
          { concurrency: 3 },
        );
      }
      assert.equal(seen.length, 6);
      for (const connectionId of [undefined, "Account", "account"]) {
        const authorization = `Basic ${Buffer.from(`${connectionId ?? "default"}@example.test:fake-${connectionId ?? "default"}`).toString("base64")}`;
        assert.deepEqual(
          seen
            .filter((request) => request.authorization === authorization)
            .map((request) => request.method)
            .sort(),
          ["GET", "PUT"],
        );
      }
      yield* api
        .request({
          host: "foreign.atlassian.net",
          operation: "foreign",
          method: "PUT",
          path: "/issue/OPS-7",
          schema: Schema.Struct({ key: Schema.String }),
        })
        .pipe(Effect.provideService(IssueTrackerHost.ConnectionId, "Account"), Effect.flip);
      assert.equal(seen.length, 6);
    }),
);

it.effect("does not unbind another tracker when the selected tracker has no saved binding", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connections.connect({ tracker: JIRA, token: "jira-token" });
    yield* f.connections.bindProject({
      projectId: ProjectId.make("A"),
      binding: { tracker: JIRA, scope: "OPS" },
    });
    const before = yield* f.bindings.list;
    f.requests.length = 0;
    yield* f.connections.bindProject({
      projectId: ProjectId.make("A"),
      tracker: LINEAR,
      binding: { value: null },
    });
    assert.deepEqual(yield* f.bindings.list, before);
    assert.equal(f.requests.length, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "adds an explicit account beside an existing legacy default without changing old refs",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.connections.connect({ tracker: LINEAR, token: "token-A" });
      yield* f.bind("default");
      const b = yield* f.add("token-B");
      yield* f.bind("B", b.connectionId);
      f.requests.length = 0;
      const catalog = yield* f.connections.list;
      assert.deepEqual(
        catalog.accounts?.map((account) => [account.connectionId, account.account]),
        [
          [undefined, "A"],
          [b.connectionId, "B"],
        ],
      );
      assert.equal(f.requests.length, 2);
      f.requests.length = 0;
      const page = yield* f.service.list({ state: "all" });
      assert.equal(f.requests.length, 4);
      assert.deepEqual(page.viewers, {
        [issueListCursorKey(f.ref("default"))]: "A",
        [issueListCursorKey(f.ref("B", b.connectionId))]: "B",
      });
      yield* f.connections.connect({
        tracker: LINEAR,
        connectionId: b.connectionId,
        token: { value: null },
      });
      assert.equal(
        (yield* f.bindings.list).get(ProjectId.make("default"))?.[0]?.connectionId,
        undefined,
      );
      f.requests.length = 0;
      assert.equal((yield* f.service.detail(f.ref("default"))).title, "A");
      assert.equal(f.requests.length, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("persists distinct Jira mount cases and protects default and selected credentials", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.connections.connect({ tracker: JIRA, token: "dc-upper-default" });
    const upper = yield* f.connections.connect({
      tracker: JIRA,
      addAccount: true,
      token: { value: "dc-upper-B" },
    });
    const lower = yield* f.connections.connect({
      tracker: JIRA,
      addAccount: true,
      token: { value: "dc-lower-B" },
    });
    assert.isDefined(upper.connectionId);
    assert.isDefined(lower.connectionId);
    assert.notEqual(upper.connectionId, lower.connectionId);
    assert.deepEqual(
      (yield* f.accounts.list).map((account) => account.host).sort(),
      ["jira.example:8443/Jira", "jira.example:8443/jira"].sort(),
    );
    for (const [projectId, connectionId] of [
      ["default", undefined],
      ["A", upper.connectionId],
      ["B", lower.connectionId],
    ] as const) {
      yield* f.connections.bindProject({
        projectId: ProjectId.make(projectId),
        tracker: JIRA,
        binding: {
          value: {
            tracker: JIRA,
            scope: "OPS",
            ...(connectionId === undefined ? {} : { connectionId }),
          },
        },
      });
    }
    const saved = yield* f.bindings.list;
    assert.equal(saved.get(ProjectId.make("default"))?.[0]?.host, "jira.example:8443/Jira");
    assert.equal(saved.get(ProjectId.make("A"))?.[0]?.host, "jira.example:8443/Jira");
    assert.equal(saved.get(ProjectId.make("B"))?.[0]?.host, "jira.example:8443/jira");
    const stored = new Map(f.stored);
    yield* f.connections
      .connect({ tracker: JIRA, addAccount: true, token: { value: "dc-upper-rotated" } })
      .pipe(Effect.flip);
    yield* f.connections
      .connect({ tracker: JIRA, connectionId: upper.connectionId, token: { value: "dc-lower-B" } })
      .pipe(Effect.flip);
    assert.deepEqual(f.stored, stored);
    const catalog = yield* f.connections.list;
    assert.equal(
      catalog.trackers.find((entry) => entry.tracker === JIRA)?.host,
      "jira.example:8443/Jira",
    );
    assert.deepEqual(
      catalog.accounts
        ?.filter((entry) => entry.connectionId !== undefined)
        .map((entry) => [entry.connectionId, entry.host, entry.account])
        .sort(),
      [
        [upper.connectionId, "jira.example:8443/Jira", "jira-user"],
        [lower.connectionId, "jira.example:8443/jira", "jira-user"],
      ].sort(),
    );
    yield* f.connections.connect({
      tracker: JIRA,
      connectionId: lower.connectionId,
      token: { value: "dc-lower-rotated" },
    });
    assert.deepEqual(yield* f.bindings.list, saved);
    assert.equal(
      new TextDecoder().decode(f.stored.get(IssueTrackerHostLive.issueTrackerSecretName(JIRA))),
      "dc-upper-default",
    );
    assert.equal(
      new TextDecoder().decode(
        f.stored.get(IssueTrackerHostLive.issueTrackerSecretName(JIRA, upper.connectionId)),
      ),
      "dc-upper-B",
    );
    assert.equal(
      new TextDecoder().decode(
        f.stored.get(IssueTrackerHostLive.issueTrackerSecretName(JIRA, lower.connectionId)),
      ),
      "dc-lower-rotated",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
