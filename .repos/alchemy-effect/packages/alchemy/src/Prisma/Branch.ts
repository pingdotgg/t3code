import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import {
  DEV_TIMESTAMP,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { Branch as ApiBranch } from "./Types.ts";

export interface BranchProps {
  /**
   * Project ID or `project.projectId` output that owns this branch.
   */
  project: string | Project;
  /**
   * Git-style branch name. If omitted, Alchemy generates a stable physical
   * name.
   */
  gitName?: string;
  /**
   * Promote this branch to be the project's default branch. Setting this to
   * `false` does not demote a current default because the Management API only
   * supports promotion; promoting another branch atomically demotes it.
   * Promotion changes `isDefault`, not the branch's immutable `preview` role.
   *
   * @default false
   */
  isDefault?: boolean;
}

export interface Branch extends Resource<
  "Prisma.Branch",
  BranchProps,
  {
    /**
     * Prisma branch ID.
     */
    branchId: string;
    /**
     * Git-style branch name.
     */
    gitName: string;
    /**
     * Project ID that owns the branch.
     */
    projectId: string;
    /**
     * Whether this branch is the project's default branch.
     */
    isDefault: boolean;
    /**
     * Branch that was default before this preview branch was promoted. Alchemy
     * restores it before deleting this resource so destroy remains reversible.
     */
    previousDefaultBranchId?: string;
    /**
     * Branch role used by Prisma to resolve deploy-time environment variables.
     */
    role: "production" | "preview";
    /**
     * ISO timestamp when the branch was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the branch was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma project branch for preview-class databases and compute resources.
 *
 * Standalone Branch resources always have the `preview` role. Promotion
 * changes only the default branch; Alchemy restores the previous default
 * before deleting a promoted branch.
 *
 * ### Creating a Branch
 * **Example:** Preview branch
 * ```typescript
 * const branch = yield* Prisma.Branch("preview", {
 *   project: project.projectId,
 *   gitName: "feature/search", // optional — omitted, a stable name is generated
 * });
 *
 * branch.role;      // "preview"
 * branch.isDefault; // false
 * ```
 *
 * ### Promoting a Branch
 * **Example:** Make a preview branch the default
 * ```typescript
 * const release = yield* Prisma.Branch("release", {
 *   project,
 *   gitName: "release/next",
 *   isDefault: true,
 * });
 *
 * release.role;      // still "preview"
 * release.isDefault; // true
 * ```
 *
 * @resource
 */
export const Branch = Resource<Branch>("Prisma.Branch");

const createGitName = (id: string, gitName: string | undefined) =>
  gitName === undefined ? createPhysicalName({ id }) : Effect.succeed(gitName);

const findBranch = (
  client: PrismaManagementClient,
  projectId: string,
  gitName: string,
) =>
  client.listBranches(projectId, { gitName }).pipe(
    Effect.flatMap((branches) => {
      const matches = branches.filter((b: ApiBranch) => b.gitName === gitName);
      return matches.length > 1
        ? Effect.fail(
            new Error(
              `Prisma project '${projectId}' has multiple branches named '${gitName}'; refusing to select one arbitrarily.`,
            ),
          )
        : Effect.succeed(matches[0]);
    }),
  );

const attrsFrom = (
  branch: ApiBranch,
  previousDefaultBranchId?: string,
): Branch["Attributes"] => ({
  branchId: branch.id,
  gitName: branch.gitName,
  projectId: branch.project.id,
  isDefault: branch.isDefault,
  ...(previousDefaultBranchId === undefined ? {} : { previousDefaultBranchId }),
  role: branch.role,
  createdAt: branch.createdAt,
  updatedAt: branch.updatedAt,
});

const ensureBranchIdentity = (
  branch: ApiBranch,
  expected: { projectId: string; gitName: string },
) =>
  branch.project.id === expected.projectId &&
  branch.gitName === expected.gitName
    ? Effect.void
    : Effect.fail(
        new Error(
          `Prisma branch '${branch.id}' belongs to project '${branch.project.id}' with git name '${branch.gitName}', but this resource requires project '${expected.projectId}' and git name '${expected.gitName}'. Refusing to promote or delete a mismatched branch.`,
        ),
      );

const ProviderLive = () =>
  Provider.effect(
    Branch,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["branchId"],
        list: Effect.fn(function* () {
          const projects = yield* client.listProjects();
          const branches = yield* Effect.forEach(
            projects,
            (project) =>
              client
                .listBranches(project.id)
                .pipe(Effect.catchIf(isNotFound, () => Effect.succeed([]))),
            { concurrency: 8 },
          );
          // Current defaults and production-role branches are project-owned
          // and undeletable through the Branch API. Project deletion removes
          // them; omit them here so unsafe nuke only receives deletable rows.
          return branches
            .flat()
            .filter(
              (branch) => !branch.isDefault && branch.role !== "production",
            )
            .map((branch) => attrsFrom(branch));
        }),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.branchId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          const newGitName = isResolved(news.gitName)
            ? yield* createGitName(id, news.gitName)
            : undefined;
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (newGitName !== undefined &&
              newGitName !==
                (output?.gitName ?? (yield* createGitName(id, olds.gitName))))
          ) {
            return { action: "replace" } as const;
          }
          if (!isResolved(news.isDefault)) return undefined;
          // The Management API can promote a branch, atomically demoting the
          // old default, but explicitly rejects demoting the current default.
          // `false` therefore means "do not promote", not "demote".
          if (news.isDefault === true && output?.isDefault !== true) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const branchId = isPrismaDevId(output?.branchId)
            ? undefined
            : output?.branchId;
          const branch = branchId
            ? yield* client
                .getBranch(branchId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findBranch(
                      client,
                      projectId,
                      yield* createGitName(id, olds.gitName),
                    )
                  : undefined;
              });
          if (!branch) return undefined;
          const attrs = attrsFrom(branch, output?.previousDefaultBranchId);
          return branchId === undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const projectId = yield* resolveProjectId(news.project);
          const gitName = yield* createGitName(id, news.gitName);
          let previousDefaultBranchId = output?.previousDefaultBranchId;
          const branchId = isPrismaDevId(output?.branchId)
            ? undefined
            : output?.branchId;
          let branch = branchId
            ? yield* client
                .getBranch(branchId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : undefined;
          if (!branch) {
            const liveBranches = yield* client.listBranches(projectId);
            const defaults = liveBranches.filter(
              (candidate) => candidate.isDefault,
            );
            if (defaults.length !== 1) {
              return yield* Effect.fail(
                new Error(
                  defaults.length === 0
                    ? `Prisma project '${projectId}' has no default branch. Refusing to create a standalone Branch because the Management API would make it the undeletable production branch; create or repair the owning Prisma.Project first.`
                    : `Prisma project '${projectId}' has ${defaults.length} default branches. Refusing to create a Branch until the project invariant is repaired.`,
                ),
              );
            }
            previousDefaultBranchId = defaults[0]!.id;
            branch = yield* client
              .createBranch(projectId, {
                gitName,
                isDefault: news.isDefault,
              })
              .pipe(
                Effect.catchIf(isConflict, () =>
                  Effect.fail(
                    new Error(
                      `Prisma branch '${gitName}' appeared after the adoption check. Refusing to take it over; rerun with adoption enabled if it is the intended branch.`,
                    ),
                  ),
                ),
              );
          }
          yield* ensureBranchIdentity(branch, {
            projectId,
            gitName,
          });
          if (news.isDefault === true && !branch.isDefault) {
            const liveBranches = yield* client.listBranches(projectId);
            const defaults = liveBranches.filter(
              (candidate) => candidate.isDefault,
            );
            if (defaults.length !== 1 || defaults[0]!.id === branch.id) {
              return yield* Effect.fail(
                new Error(
                  `Prisma project '${projectId}' does not have exactly one different default branch to restore later. Refusing to promote '${branch.gitName}'.`,
                ),
              );
            }
            previousDefaultBranchId = defaults[0]!.id;
            branch = yield* client.updateBranch(branch.id, {
              isDefault: true,
            });
            yield* ensureBranchIdentity(branch, {
              projectId,
              gitName,
            });
            if (!branch.isDefault) {
              return yield* Effect.fail(
                new Error(
                  `Prisma branch '${branch.id}' promotion did not converge to the default branch.`,
                ),
              );
            }
          }
          return attrsFrom(branch, previousDefaultBranchId);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.branchId)) return;
          const branch = yield* client
            .getBranch(output.branchId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!branch) return;
          yield* ensureBranchIdentity(branch, {
            projectId: output.projectId,
            gitName: output.gitName,
          });
          if (branch.role === "production") {
            return yield* Effect.fail(
              new Error(
                `Cannot delete Prisma branch '${branch.gitName ?? output.branchId}' directly because its production role is immutable. Delete the owning Prisma.Project.`,
              ),
            );
          }
          if (branch.isDefault) {
            const previousDefaultBranchId = output.previousDefaultBranchId;
            if (
              previousDefaultBranchId === undefined ||
              previousDefaultBranchId === branch.id
            ) {
              return yield* Effect.fail(
                new Error(
                  `Cannot safely delete default Prisma branch '${branch.gitName}' because state does not identify the branch it displaced. Promote another branch explicitly before deleting this resource.`,
                ),
              );
            }
            const previous = yield* client
              .getBranch(previousDefaultBranchId)
              .pipe(
                Effect.catchIf(isNotFound, () =>
                  Effect.fail(
                    new Error(
                      `Cannot restore previous default Prisma branch '${previousDefaultBranchId}' because it no longer exists. Promote another branch explicitly before deleting '${branch.gitName}'.`,
                    ),
                  ),
                ),
              );
            if (
              previous.project.id !== output.projectId ||
              previous.id === branch.id
            ) {
              return yield* Effect.fail(
                new Error(
                  `Previous default Prisma branch '${previous.id}' does not belong to project '${output.projectId}'. Refusing an unsafe promotion.`,
                ),
              );
            }
            const restored = previous.isDefault
              ? previous
              : yield* client.updateBranch(previous.id, { isDefault: true });
            if (
              restored.id !== previous.id ||
              restored.project.id !== output.projectId ||
              !restored.isDefault
            ) {
              return yield* Effect.fail(
                new Error(
                  `Prisma did not confirm restoration of previous default branch '${previous.id}'. Refusing to delete '${branch.gitName}'.`,
                ),
              );
            }
            const demoted = yield* client
              .getBranch(branch.id)
              .pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              );
            if (!demoted) return;
            yield* ensureBranchIdentity(demoted, {
              projectId: output.projectId,
              gitName: output.gitName,
            });
            if (demoted.isDefault) {
              return yield* Effect.fail(
                new Error(
                  `Prisma branch '${branch.gitName}' remained default after restoring '${previous.gitName}'. Refusing to delete it.`,
                ),
              );
            }
          }
          yield* client
            .deleteBranch(output.branchId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(Branch, ["branchId"], ({ id, news }) => ({
    branchId: devId("branch", id),
    gitName: news.gitName ?? id,
    projectId: attrOrString(news.project, "projectId"),
    isDefault: news.isDefault ?? false,
    role: news.isDefault ? "production" : "preview",
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

export const BranchProvider = () =>
  ProviderLayer.dual(Branch, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
