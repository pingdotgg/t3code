import { expect, it } from "@effect/vitest";
import { ProjectId, IsoDateTime } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeExtensionScopeResolver } from "./scope.ts";

const projectId = ProjectId.make("project-a");
const context = {
  resource: {
    namespace: "test.scope",
    id: "file",
    environmentId: "env-a",
    projectId,
    threadId: "thread-a",
  },
  client: "web",
  workspaceRevision: JSON.stringify(["/project", "/worktree"]),
};
const project = { projectId, workspaceRoot: "/project", deletedAt: null };
const thread = { projectId, worktreePath: "/worktree", deletedAt: null };
function resolver(
  overrides: { project?: typeof project | null; thread?: typeof thread | null } = {},
) {
  return makeExtensionScopeResolver({
    environmentId: "env-a",
    projects: {
      getById: () =>
        Effect.succeed(
          Option.fromNullishOr(overrides.project === undefined ? project : overrides.project),
        ),
    },
    threads: {
      getById: () =>
        Effect.succeed(
          Option.fromNullishOr(overrides.thread === undefined ? thread : overrides.thread),
        ),
    },
  });
}
it.effect(
  "derives cwd from server thread and rejects caller revision or cross-environment scope",
  () =>
    Effect.gen(function* () {
      const resolve = resolver();
      const scope = yield* resolve(context);
      expect(scope.cwd).toBe("/worktree");
      expect(scope.context.workspaceRevision).toBe(context.workspaceRevision);
      expect(
        (yield* Effect.flip(
          resolve({ ...context, resource: { ...context.resource, environmentId: "env-b" } }),
        )).detail,
      ).toContain("environment");
      expect(
        (yield* Effect.flip(resolve({ ...context, workspaceRevision: "/caller-cwd" }))).detail,
      ).toContain("stale");
    }),
);
it.effect(
  "MCP derivation fills project and revision from credential thread, never caller cwd",
  () =>
    Effect.gen(function* () {
      const scope = yield* resolver()(
        {
          resource: {
            namespace: "test.scope",
            id: "thread-a",
            environmentId: "env-a",
            threadId: "thread-a",
          },
          client: "mcp",
        },
        true,
      );
      expect(scope.context.resource.projectId).toBe(projectId);
      expect(scope.context.workspaceRevision).toBe(context.workspaceRevision);
    }),
);
it.effect("missing or mismatched project/thread cannot authorize a read", () =>
  Effect.gen(function* () {
    for (const resolve of [
      resolver({ project: null }),
      resolver({ thread: null }),
      resolver({ thread: { ...thread, projectId: ProjectId.make("other") } }),
    ])
      expect((yield* Effect.flip(resolve(context)))._tag).toBe("ExtensionOperationError");
  }),
);
it.effect("rechecking a captured scope rejects workspace movement and tombstones", () =>
  Effect.gen(function* () {
    let currentThread: {
      projectId: ProjectId;
      worktreePath: string;
      deletedAt: IsoDateTime | null;
    } = { ...thread };
    const resolve = makeExtensionScopeResolver({
      environmentId: "env-a",
      projects: { getById: () => Effect.succeed(Option.some(project)) },
      threads: { getById: () => Effect.succeed(Option.some(currentThread)) },
    });
    const initial = yield* resolve(context);
    currentThread = { ...currentThread, worktreePath: "/changed" };
    expect((yield* Effect.flip(resolve(initial.context))).detail).toContain("stale");
    currentThread = { ...thread, deletedAt: IsoDateTime.make("2026-09-09T00:00:00.000Z") };
    expect((yield* Effect.flip(resolve(initial.context))).detail).toContain("unavailable");
  }),
);
