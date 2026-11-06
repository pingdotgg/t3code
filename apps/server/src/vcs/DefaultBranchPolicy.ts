import { GitCommandError, type ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { defaultBranchSettingsKey, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

// Standalone Git drivers have no project settings; the server supplies the project policy.
export class DefaultBranchPolicy extends Context.Reference<{
  readonly changes: Stream.Stream<unknown>;
  readonly getOverride: (input: {
    readonly cwd: string;
    readonly repository: Effect.Effect<
      {
        readonly worktreeRoot: string | null;
        readonly repositoryRoot: string;
      } | null,
      GitCommandError
    >;
  }) => Effect.Effect<string | null, GitCommandError>;
}>("t3/vcs/DefaultBranchPolicy", {
  defaultValue: () => ({ getOverride: () => Effect.succeed(null), changes: Stream.empty }),
}) {}

export const layer = Layer.effect(
  DefaultBranchPolicy,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      changes: Stream.unwrap(
        Effect.gen(function* () {
          const changes = yield* settingsService.subscribeChanges;
          const initial = yield* settingsService.getSettings;
          return Stream.concat(Stream.make(initial), changes);
        }),
      ).pipe(
        Stream.map(defaultBranchSettingsKey),
        Stream.changes,
        Stream.drop(1),
        Stream.catch(() => Stream.empty),
      ),
      getOverride: Effect.fn("DefaultBranchPolicy.getOverride")(
        function* (input) {
          const settings = yield* settingsService.getSettings;
          if (
            settings.defaultBranch === null &&
            !Object.values(settings.projectSettingsOverrides).some(
              (override) => override.defaultBranch != null,
            )
          )
            return null;

          const repository = yield* input.repository;
          if (repository === null) return null;
          const workspaceRoot = path.normalize(repository.worktreeRoot ?? input.cwd);
          let project = yield* projects.findActiveByWorkspaceRoot(path.normalize(input.cwd));
          if (Option.isNone(project)) {
            const enclosing = (yield* projects.listShells())
              .filter((candidate) => {
                const relative = path.relative(candidate.workspaceRoot, input.cwd);
                return (
                  relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative)
                );
              })
              .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
            project = enclosing
              ? yield* projects.get(enclosing.id)
              : yield* projects.findActiveByWorkspaceRoot(workspaceRoot);
          }
          if (Option.isNone(project)) {
            const threads = yield* sql<{ readonly projectId: ProjectId }>`
              SELECT project_id AS "projectId"
              FROM orchestration_v2_projection_threads
              WHERE deleted_at IS NULL
                AND json_extract(payload_json, '$.worktreePath') = ${workspaceRoot}
              LIMIT 1
            `.pipe(NodeSqliteClient.readOnly);
            const thread = threads[0];
            project = thread
              ? yield* projects.get(thread.projectId)
              : yield* projects.findActiveByWorkspaceRoot(
                  path.normalize(repository.repositoryRoot),
                );
          }
          if (Option.isNone(project)) {
            const candidates = yield* projects.listShells();
            for (const candidate of candidates) {
              if (settings.projectSettingsOverrides[candidate.id]?.defaultBranch == null) continue;
              const physicalRoot = yield* fileSystem
                .realPath(candidate.workspaceRoot)
                .pipe(Effect.orElseSucceed(() => null));
              if (physicalRoot === workspaceRoot || physicalRoot === repository.repositoryRoot) {
                project = yield* projects.get(candidate.id);
                break;
              }
            }
          }
          return resolveProjectSettings(
            settings,
            Option.isSome(project) ? project.value.projectId : null,
          ).settings.defaultBranch;
        },
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "DefaultBranchPolicy.getOverride",
              command: "settings",
              cwd: "<project>",
              detail: "Could not read the project's default branch setting.",
              cause,
            }),
        ),
      ),
    };
  }),
);
