/**
 * One Railway project for the live test process. Not a stack resource —
 * tests pass it as `project:` so `stack.destroy()` cannot delete it.
 *
 * Named so `matchesAlchemyPhysicalName` still lists it (service `list()`
 * walks owned projects) and `pnpm nuke` can reclaim it.
 */
import { Query } from "@distilled.cloud/core/query";
import { GraphQLLive, Railway } from "@distilled.cloud/railway";
import { RailwayAuth } from "@/Railway/AuthProvider.ts";
import { fromAuthProvider } from "@/Railway/Credentials.ts";
import { resolveWorkspace } from "@/Railway/Environment.ts";
import { Environment } from "@/Railway/ProjectEnvironment.ts";
import { createProject, type Project } from "@/Railway/Project.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { SUITE_PROJECT_NAME } from "./suiteProjectName.ts";

export { SUITE_PROJECT_NAME } from "./suiteProjectName.ts";

const toProject = (
  project: {
    id: string;
    name?: string | null;
    workspaceId?: string | null;
    workspace?: { id: string } | null;
    primaryEnvironmentId?: string | null;
    baseEnvironmentId?: string | null;
    baseEnvironment?: { id: string } | null;
    deletedAt?: string | null;
  },
  workspaceId: string,
): Project["Attributes"] => ({
  projectId: project.id,
  name: project.name || SUITE_PROJECT_NAME,
  workspaceId: project.workspaceId ?? project.workspace?.id ?? workspaceId,
  environmentId:
    project.primaryEnvironmentId ??
    project.baseEnvironmentId ??
    project.baseEnvironment?.id ??
    "",
  url: `https://railway.com/project/${project.id}`,
});

const workspaceProjects = (workspaceId: string) =>
  Query.items(
    Railway.projects({ workspaceId, first: 50, includeDeleted: false }).pipe(
      Query.map((project) => ({
        id: project.id,
        name: project.name,
        workspaceId: project.workspaceId,
        primaryEnvironmentId: project.primaryEnvironmentId,
        baseEnvironmentId: project.baseEnvironmentId,
        deletedAt: project.deletedAt,
      })),
    ),
  );

const readProject = Query.fn((id: string) => {
  const project = Railway.project({ id });
  return {
    id: project.id,
    name: project.name,
    workspaceId: project.workspaceId,
    primaryEnvironmentId: project.primaryEnvironmentId,
    baseEnvironmentId: project.baseEnvironmentId,
  };
});

const projectEnvironments = (projectId: string) =>
  Query.items(
    Railway.environments({ projectId, first: 5 }).pipe(
      Query.map((env) => ({ id: env.id, deletedAt: env.deletedAt })),
    ),
  );

const findByName = (workspaceId: string) =>
  workspaceProjects(workspaceId).pipe(
    Stream.filter(
      (project) =>
        project.deletedAt == null && project.name === SUITE_PROJECT_NAME,
    ),
    Stream.take(1),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
  );

const acquire = Effect.gen(function* () {
  const workspace = yield* resolveWorkspace();
  const existing = yield* findByName(workspace.id);
  const resolve = (project: Parameters<typeof toProject>[0]) =>
    Effect.gen(function* () {
      let attrs = toProject(project, workspace.id);
      if (attrs.environmentId.length === 0) {
        const fresh = yield* readProject(attrs.projectId);
        attrs = toProject(fresh, workspace.id);
      }
      if (attrs.environmentId.length > 0) {
        return attrs;
      }
      const env = yield* projectEnvironments(attrs.projectId).pipe(
        Stream.filter((item) => item.deletedAt == null),
        Stream.take(1),
        Stream.runHead,
      );
      return env._tag === "Some"
        ? { ...attrs, environmentId: env.value.id }
        : attrs;
    });

  if (existing !== undefined) {
    return yield* resolve(existing);
  }

  return yield* createProject({
    name: SUITE_PROJECT_NAME,
    workspaceId: workspace.id,
    description: "alchemy railway live-test suite (shared)",
  }).pipe(
    Effect.flatMap((project) => resolve(project)),
    Effect.catch((error) =>
      findByName(workspace.id).pipe(
        Effect.flatMap((found) =>
          found !== undefined ? resolve(found) : Effect.fail(error),
        ),
      ),
    ),
  );
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      GraphQLLive,
      fromAuthProvider().pipe(Layer.provide(RailwayAuth)),
    ),
  ),
);

/**
 * Process-cached create-or-get. Yield it inside a test or pass the
 * Effect as `project:` (resource-valued props accept Effects).
 */
export const suiteProject = Effect.runSync(
  Effect.cached(
    acquire.pipe(
      Effect.map((attrs) => attrs as unknown as Project),
      Effect.orDie,
    ),
  ),
);

/**
 * Empty extra environment on {@link suiteProject}. Yield inside
 * `stack.deploy` so destroy deletes the partition. Does not fork
 * production (`sourceEnvironmentId` omitted).
 */
export const suitePartition = Effect.gen(function* () {
  const project = yield* suiteProject;
  const environment = yield* Environment("Partition", { project });
  return { project, environment };
});
