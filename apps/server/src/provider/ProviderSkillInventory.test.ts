import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { resolveProviderSkillInventory } from "./ProviderSkillInventory.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

const PROJECT_ID = ProjectId.make("project-a");
const OTHER_PROJECT_ID = ProjectId.make("project-b");
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("cursor-default");

const skill = (name: string): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
});

/**
 * A provider instance with only the fields this module touches. The rest of
 * `ProviderInstance` is adapter/text-generation surface that inventory
 * resolution never reaches.
 */
const makeInstance = (input: {
  readonly snapshotSkills?: ReadonlyArray<ServerProviderSkill>;
  readonly inventory?: (cwd: string) => ReadonlyArray<ServerProviderSkill>;
  readonly observedCwds?: Array<string>;
}): ProviderInstance =>
  ({
    instanceId: INSTANCE_ID,
    snapshot: {
      getSnapshot: Effect.succeed({ skills: input.snapshotSkills ?? [] } as ServerProvider),
    },
    ...(input.inventory
      ? {
          skillInventory: {
            list: ({ cwd }: { readonly cwd: string }) => {
              input.observedCwds?.push(cwd);
              return Effect.succeed(input.inventory?.(cwd) ?? []);
            },
          },
        }
      : {}),
  }) as unknown as ProviderInstance;

/**
 * Only the two read-model lookups this module performs are stubbed; the
 * projected rows carry just the fields cwd resolution reads.
 */
const projectionLayer = (input: {
  readonly projects?: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly projectReadError?: PersistenceSqlError;
  readonly threadContext?: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string | null;
    readonly worktreePath: string | null;
  };
  readonly threadReadError?: PersistenceSqlError;
}) =>
  Layer.mock(ProjectionSnapshotQuery)({
    getProjectShellById: ((projectId: ProjectId) =>
      input.projectReadError ??
      Effect.succeed(
        Option.fromNullishOr(input.projects?.find((project) => project.id === projectId)),
      )) as unknown as ProjectionSnapshotQuery["Service"]["getProjectShellById"],
    getThreadWorkspaceContextById: ((threadId: ThreadId) =>
      input.threadReadError ??
      Effect.succeed(
        Option.map(Option.fromNullishOr(input.threadContext), (context) => ({
          threadId,
          ...context,
        })),
      )) as unknown as ProjectionSnapshotQuery["Service"]["getThreadWorkspaceContextById"],
  });

const registryLayer = (instance: ProviderInstance | undefined) =>
  Layer.mock(ProviderInstanceRegistry)({
    getInstance: () => Effect.succeed(instance),
  });

it.effect("resolves project scope to the project's authoritative workspace root", () =>
  Effect.gen(function* () {
    const observedCwds: Array<string> = [];
    const skills = yield* resolveProviderSkillInventory({
      scope: { kind: "project", projectId: PROJECT_ID },
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryLayer(makeInstance({ inventory: (cwd) => [skill(cwd)], observedCwds })),
          projectionLayer({
            projects: [
              { id: PROJECT_ID, workspaceRoot: "/repos/a" },
              { id: OTHER_PROJECT_ID, workspaceRoot: "/repos/b" },
            ],
          }),
        ),
      ),
    );

    assert.deepEqual(observedCwds, ["/repos/a"]);
    assert.deepEqual(
      skills.map((entry) => entry.name),
      ["/repos/a"],
    );
  }),
);

/**
 * The finding that motivated the scope shape: a worktree thread's agent runs
 * in the worktree, so the picker must list the worktree's skills.
 */
it.effect("resolves thread scope to the thread's worktree when it has one", () =>
  Effect.gen(function* () {
    const observedCwds: Array<string> = [];
    yield* resolveProviderSkillInventory({
      scope: { kind: "thread", threadId: THREAD_ID },
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryLayer(makeInstance({ inventory: () => [], observedCwds })),
          projectionLayer({
            threadContext: {
              projectId: PROJECT_ID,
              workspaceRoot: "/repos/a",
              worktreePath: "/repos/a-worktrees/feature",
            },
          }),
        ),
      ),
    );

    assert.deepEqual(observedCwds, ["/repos/a-worktrees/feature"]);
  }),
);

it.effect("resolves an archived thread scope to the thread's worktree", () =>
  Effect.gen(function* () {
    const observedCwds: Array<string> = [];
    yield* resolveProviderSkillInventory({
      scope: { kind: "thread", threadId: THREAD_ID },
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryLayer(makeInstance({ inventory: () => [], observedCwds })),
          projectionLayer({
            threadContext: {
              projectId: PROJECT_ID,
              workspaceRoot: "/repos/a",
              worktreePath: "/repos/a-worktrees/archived",
            },
          }),
        ),
      ),
    );

    assert.deepEqual(observedCwds, ["/repos/a-worktrees/archived"]);
  }),
);

it.effect("resolves a worktree thread even when the project row is missing", () =>
  Effect.gen(function* () {
    const observedCwds: Array<string> = [];
    yield* resolveProviderSkillInventory({
      scope: { kind: "thread", threadId: THREAD_ID },
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryLayer(makeInstance({ inventory: () => [], observedCwds })),
          projectionLayer({
            threadContext: {
              projectId: PROJECT_ID,
              workspaceRoot: null,
              worktreePath: "/repos/a-worktrees/feature",
            },
          }),
        ),
      ),
    );

    assert.deepEqual(observedCwds, ["/repos/a-worktrees/feature"]);
  }),
);

it.effect("falls back to the project workspace root for a thread without a worktree", () =>
  Effect.gen(function* () {
    const observedCwds: Array<string> = [];
    yield* resolveProviderSkillInventory({
      scope: { kind: "thread", threadId: THREAD_ID },
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryLayer(makeInstance({ inventory: () => [], observedCwds })),
          projectionLayer({
            threadContext: {
              projectId: PROJECT_ID,
              workspaceRoot: "/repos/a",
              worktreePath: null,
            },
          }),
        ),
      ),
    );

    assert.deepEqual(observedCwds, ["/repos/a"]);
  }),
);

it.effect("returns snapshot skills for a provider without the capability", () =>
  Effect.gen(function* () {
    const skills = yield* resolveProviderSkillInventory({
      scope: { kind: "project", projectId: PROJECT_ID },
      instanceId: INSTANCE_ID,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryLayer(makeInstance({ snapshotSkills: [skill("from-snapshot")] })),
          // Deliberately empty: a snapshot-mode provider must answer without
          // the scope resolving to anything at all.
          projectionLayer({}),
        ),
      ),
    );

    assert.deepEqual(
      skills.map((entry) => entry.name),
      ["from-snapshot"],
    );
  }),
);

it.effect("fails with a typed error for an unknown instance", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveProviderSkillInventory({
        scope: { kind: "project", projectId: PROJECT_ID },
        instanceId: INSTANCE_ID,
      }).pipe(Effect.provide(Layer.mergeAll(registryLayer(undefined), projectionLayer({})))),
    );

    assert.equal(error._tag, "ServerProviderSkillInventoryError");
    assert.equal(error.failure, "unknown_instance");
    assert.equal(error.instanceId, INSTANCE_ID);
    assert.deepEqual(error.scope, { kind: "project", projectId: PROJECT_ID });
  }),
);

it.effect("fails with a typed error for an unknown project", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveProviderSkillInventory({
        scope: { kind: "project", projectId: PROJECT_ID },
        instanceId: INSTANCE_ID,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            registryLayer(makeInstance({ inventory: () => [] })),
            projectionLayer({ projects: [] }),
          ),
        ),
      ),
    );

    assert.equal(error._tag, "ServerProviderSkillInventoryError");
    assert.equal(error.failure, "unknown_project");
    assert.equal(error.instanceId, INSTANCE_ID);
    assert.deepEqual(error.scope, { kind: "project", projectId: PROJECT_ID });
  }),
);

it.effect("fails with a typed error for an unknown thread", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveProviderSkillInventory({
        scope: { kind: "thread", threadId: THREAD_ID },
        instanceId: INSTANCE_ID,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            registryLayer(makeInstance({ inventory: () => [] })),
            projectionLayer({ projects: [{ id: PROJECT_ID, workspaceRoot: "/repos/a" }] }),
          ),
        ),
      ),
    );

    assert.equal(error._tag, "ServerProviderSkillInventoryError");
    assert.equal(error.failure, "unknown_thread");
    assert.equal(error.instanceId, INSTANCE_ID);
    assert.deepEqual(error.scope, { kind: "thread", threadId: THREAD_ID });
  }),
);

it.effect("classifies a project read-model failure", () =>
  Effect.gen(function* () {
    const projectReadError = new PersistenceSqlError({ operation: "read project shell" });
    const error = yield* Effect.flip(
      resolveProviderSkillInventory({
        scope: { kind: "project", projectId: PROJECT_ID },
        instanceId: INSTANCE_ID,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            registryLayer(makeInstance({ inventory: () => [] })),
            projectionLayer({ projectReadError }),
          ),
        ),
      ),
    );

    assert.equal(error.failure, "project_read_model_unavailable");
    assert.equal(error.cause, projectReadError);
  }),
);

it.effect("classifies a thread read-model failure", () =>
  Effect.gen(function* () {
    const threadReadError = new PersistenceSqlError({ operation: "read thread workspace" });
    const error = yield* Effect.flip(
      resolveProviderSkillInventory({
        scope: { kind: "thread", threadId: THREAD_ID },
        instanceId: INSTANCE_ID,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            registryLayer(makeInstance({ inventory: () => [] })),
            projectionLayer({ threadReadError }),
          ),
        ),
      ),
    );

    assert.equal(error.failure, "thread_read_model_unavailable");
    assert.equal(error.cause, threadReadError);
  }),
);

it.effect("classifies a thread without a resolvable workspace", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveProviderSkillInventory({
        scope: { kind: "thread", threadId: THREAD_ID },
        instanceId: INSTANCE_ID,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            registryLayer(makeInstance({ inventory: () => [] })),
            projectionLayer({
              threadContext: {
                projectId: PROJECT_ID,
                workspaceRoot: null,
                worktreePath: null,
              },
            }),
          ),
        ),
      ),
    );

    assert.equal(error.failure, "unresolvable_workspace");
    assert.deepEqual(error.scope, { kind: "thread", threadId: THREAD_ID });
  }),
);
