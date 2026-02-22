/**
 * ProjectRepository - Repository interface for project persistence.
 *
 * Owns persisted project records (cwd, scripts, and cleanup of missing paths).
 * It does not manage provider sessions, orchestration events, or websocket APIs.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for all operations.
 *
 * @module ProjectRepository
 */
import type {
  ProjectAddInput,
  ProjectAddResult,
  ProjectListResult,
  ProjectRemoveInput,
  ProjectUpdateScriptsInput,
  ProjectUpdateScriptsResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectRepositoryError } from "../Errors.ts";

export interface ProjectRepositoryShape {
  /**
   * List all persisted projects.
   *
   * @returns Effect containing all project records.
   */
  readonly list: () => Effect.Effect<ProjectListResult, ProjectRepositoryError>;

  /**
   * Add a project by cwd, or return the existing project when the cwd already exists.
   *
   * @param input - Project creation payload.
   * @returns Effect containing the project and whether it was newly created.
   */
  readonly add: (input: ProjectAddInput) => Effect.Effect<ProjectAddResult, ProjectRepositoryError>;

  /**
   * Remove a persisted project.
   *
   * @param input - Project removal payload.
   * @returns Effect containing void.
   */
  readonly remove: (input: ProjectRemoveInput) => Effect.Effect<void, ProjectRepositoryError>;

  /**
   * Update the scripts for an existing project.
   *
   * @param input - Script update payload.
   * @returns Effect containing the updated project.
   */
  readonly updateScripts: (
    input: ProjectUpdateScriptsInput,
  ) => Effect.Effect<ProjectUpdateScriptsResult, ProjectRepositoryError>;

  /**
   * Remove projects whose cwd no longer exists on disk.
   *
   * @returns Effect containing void.
   */
  readonly pruneMissing: () => Effect.Effect<void, ProjectRepositoryError>;
}

/**
 * ProjectRepository - Service tag for project persistence dependency injection.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const projects = yield* ProjectRepository
 *   return yield* projects.list()
 * })
 * ```
 */
export class ProjectRepository extends ServiceMap.Service<
  ProjectRepository,
  ProjectRepositoryShape
>()("persistence/ProjectRepository") {}
