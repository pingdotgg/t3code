import { it, assert } from "@effect/vitest";
import { ProjectId, ThreadId, type Project, type TaskRequest } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import migration from "../persistence/Migrations/057_ExternalTaskLinks.ts";
import { TaskService, layer } from "./TaskService.ts";

const projectId = ProjectId.make("project-one");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const project: Project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  scripts: [],
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};
function dependencies(
  execute: GitHubCli.GitHubCli["Service"]["execute"],
  http = HttpClient.make(() => Effect.die("Unexpected HTTP request")),
) {
  const values = new Map<string, Uint8Array>();
  return Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (key) => Effect.succeed(Option.fromNullishOr(values.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          values.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          values.delete(key);
        }),
    }),
    Layer.mock(GitHubCli.GitHubCli)({ execute }),
    Layer.succeed(HttpClient.HttpClient, http),
  );
}
const result = {
  stdout: '{"id":7}',
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  exitCode: 0 as never,
};
const comment: TaskRequest = {
  projectId,
  action: "comment",
  id: "7",
  comment: "Review this",
  operationId: "write-one",
};
it.effect(
  "allows corrected requests to reuse an operation ID when validation sent no write",
  () => {
    let writes = 0;
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* TaskService;
      yield* service.configure({
        projectId,
        source: { provider: "github", baseUrl: "https://github.com", scope: "org/repo" },
      });
      for (const invalidRequest of [
        { ...comment, id: "https://github.com/another/repo/issues/7" },
        { ...comment, action: "update" as const, changes: { priority: "1" } },
      ]) {
        const error = yield* service.execute(invalidRequest).pipe(Effect.flip);
        assert.equal(error.code, "invalid");
        assert.equal(writes, 0);
      }
      yield* service.execute(comment);
      yield* service.execute(comment);
      assert.equal(writes, 1);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            dependencies(() =>
              Effect.sync(() => {
                writes++;
                return result;
              }),
            ),
          ),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    );
  },
);

it.effect(
  "allows retry after Linear scope preflight fails, but never repeats an ambiguous mutation",
  () => {
    let requests = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        const response =
          requests === 1
            ? { data: { issue: { team: { id: "other-team" } } } }
            : requests === 2
              ? { data: { issue: { team: { id: "team-id" } } } }
              : { error: "Response lost" };
        return HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(response), { status: requests === 3 ? 502 : 200 }),
        );
      }),
    );
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* TaskService;
      yield* service.configure({
        projectId,
        source: { provider: "linear", baseUrl: "https://linear.app", scope: "team-id" },
        token: Redacted.make("private-token"),
      });
      assert.equal((yield* service.execute(comment).pipe(Effect.flip)).code, "invalid");
      assert.equal(requests, 1);
      assert.equal((yield* service.execute(comment).pipe(Effect.flip)).code, "unavailable");
      assert.equal(requests, 3);
      assert.equal((yield* service.execute(comment).pipe(Effect.flip)).code, "uncertain-write");
      assert.equal(requests, 3);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(dependencies(() => Effect.die("Unexpected GitHub request"), http)),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    );
  },
);
it.effect("journals confirmed external writes and rejects reuse for a different change", () => {
  let writes = 0;
  return Effect.gen(function* () {
    yield* migration;
    const service = yield* TaskService;
    yield* service.configure({
      projectId,
      source: { provider: "github", baseUrl: "https://github.com", scope: "org/repo" },
    });
    const first = yield* service.execute(comment);
    const second = yield* service.execute(comment);
    assert.deepEqual(first, second);
    assert.equal(writes, 1);
    const error = yield* service.execute({ ...comment, comment: "Different" }).pipe(Effect.flip);
    assert.equal(error.code, "invalid");
    assert.equal(writes, 1);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          dependencies(() =>
            Effect.sync(() => {
              writes++;
              return result;
            }),
          ),
        ),
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});
it.effect(
  "does not replay a write after an ambiguous transport failure or expose its cause",
  () => {
    let writes = 0;
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* TaskService;
      yield* service.configure({
        projectId,
        source: { provider: "github", baseUrl: "https://github.com", scope: "org/repo" },
      });
      const first = yield* service.execute(comment).pipe(Effect.flip);
      assert.notInclude(encodeJson(first), "private-token");
      const retry = yield* service.execute(comment).pipe(Effect.flip);
      assert.equal(retry.code, "uncertain-write");
      assert.equal(writes, 1);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            dependencies(() =>
              Effect.suspend(() => {
                writes++;
                return Effect.fail(
                  new GitHubCli.GitHubCliAuthenticationError({
                    command: "gh",
                    cwd: "/repo",
                    cause: new Error("private-token"),
                  }),
                );
              }),
            ),
          ),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    );
  },
);
it.effect(
  "maps Linear authentication, permission and rate-limit failures without retrying or leaking responses",
  () => {
    let status = 401;
    let requests = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"error":"private-token"}', { status }),
        );
      }),
    );
    return Effect.gen(function* () {
      yield* migration;
      const service = yield* TaskService;
      yield* service.configure({
        projectId,
        source: { provider: "linear", baseUrl: "https://linear.app", scope: "team-id" },
        token: Redacted.make("private-token"),
      });
      yield* Effect.forEach([401, 403, 429], (nextStatus) =>
        Effect.gen(function* () {
          status = nextStatus;
          const error = yield* service.execute({ projectId, action: "list" }).pipe(Effect.flip);
          assert.equal(error.code, status === 429 ? "rate-limit" : "authentication");
          assert.notInclude(encodeJson(error), "private-token");
        }),
      );
      assert.equal(requests, 3);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(dependencies(() => Effect.die("Unexpected GitHub request"), http)),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    );
  },
);
it.effect(
  "returns connection metadata without credentials and preserves typed links after disconnect",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const service = yield* TaskService;
      yield* service.configure({
        projectId,
        source: { provider: "linear", baseUrl: "https://linear.app", scope: "team-id" },
        token: Redacted.make("private-token"),
      });
      assert.notInclude(
        encodeJson(yield* service.execute({ projectId, action: "status" })),
        "private-token",
      );
      const link = {
        projectId,
        threadId: ThreadId.make("thread-one"),
        provider: "linear" as const,
        taskUrl: "https://linear.app/team/issue/ABC-1",
        taskKey: "ABC-1",
        title: "Task",
      };
      yield* service.execute({ projectId, action: "link", link });
      yield* service.execute({ projectId, action: "link", link });
      const raced = yield* service.execute({
        projectId,
        action: "link",
        link: { ...link, threadId: ThreadId.make("racing-thread") },
      });
      assert.equal(raced.links[0]?.threadId, link.threadId);
      yield* service.configure({ projectId, source: null });
      const links = yield* service.execute({ projectId, action: "links", threadId: link.threadId });
      assert.deepEqual(links.links, [link]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(dependencies(() => Effect.succeed(result))),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
);
