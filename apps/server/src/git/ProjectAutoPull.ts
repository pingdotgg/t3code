import { Clock, Context, Effect, FileSystem, Layer, PubSub, Stream } from "effect";
import type { Scope } from "effect";
import type { OrchestrationProject, ProjectId } from "@t3tools/contracts";
import { threadCheckoutHasUnsettledWork } from "../orchestration/commandInvariants.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { GitCore, type GitStatusDetails } from "./Services/GitCore.ts";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "./CheckoutCoordinator.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

function autoPullSkipReason(status: GitStatusDetails): string | null {
  if (!status.isRepo) return "not-a-repository";
  if (!status.isDefaultBranch) return "not-default-branch";
  if (!status.hasUpstream) return "no-upstream";
  if (status.hasWorkingTreeChanges) return "local-changes";
  if (status.aheadCount > 0) return "local-commits";
  if (status.behindCount <= 0) return "up-to-date";
  return null;
}

export class ProjectAutoPull extends Context.Service<
  ProjectAutoPull,
  {
    readonly attempt: (cwd: string) => Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly changes: Stream.Stream<string>;
  }
>()("t3/git/ProjectAutoPull") {}

export const ProjectAutoPullLive = Layer.effect(
  ProjectAutoPull,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const git = yield* GitCore;
    const fs = yield* FileSystem.FileSystem;
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<string>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    const coordinator = yield* CheckoutCoordinator;
    const provider = yield* ProviderService;
    const failures = new Map<string, { count: number; retryAt: number }>();

    const enabledProjects = Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      return model.projects.filter((project) => !project.deletedAt && project.autoPull === true);
    });

    let indexedProjects: readonly OrchestrationProject[] | undefined;
    let projectById = new Map<ProjectId, OrchestrationProject>();
    const indexProjects = (projects: readonly OrchestrationProject[]) => {
      if (indexedProjects !== projects) {
        indexedProjects = projects;
        projectById = new Map(projects.map((project) => [project.id, project]));
      }
      return projectById;
    };

    const resolveEnabledProjects = (projects: readonly OrchestrationProject[]) =>
      Effect.gen(function* () {
        const roots = new Map<string, Set<ProjectId>>();
        for (const project of projects) {
          const root = yield* fs.realPath(project.workspaceRoot).pipe(
            Effect.catchTag("PlatformError", (cause) =>
              Effect.logWarning("Automatic pull project path unavailable", {
                projectId: project.id,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (root === null) continue;
          const ids = roots.get(root) ?? new Set<ProjectId>();
          ids.add(project.id);
          roots.set(root, ids);
        }
        return roots;
      });

    const eligible = (cwd: string, projectIds: ReadonlySet<ProjectId>) =>
      Effect.gen(function* () {
        if (yield* coordinator.isFinalizing(cwd)) return false;
        const model = yield* engine.getReadModel();
        const projects = indexProjects(model.projects);
        let enabled = false;
        for (const id of projectIds) {
          const project = projects.get(id);
          if (!project || project.deletedAt || project.autoPull !== true) continue;
          const root = yield* fs.realPath(project.workspaceRoot).pipe(
            Effect.catchTag("PlatformError", (cause) =>
              Effect.logWarning("Automatic pull project path unavailable", {
                projectId: project.id,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (root === cwd) {
            enabled = true;
            break;
          }
        }
        if (!enabled) return false;
        for (const thread of model.threads) {
          // Broader than turn admission: a message waiting for a turn that never
          // started still means the branch must not move under this thread.
          if (
            !threadCheckoutHasUnsettledWork(thread) &&
            !thread.session?.activeTurnId &&
            !(thread.queuedTurns ?? []).some((turn) => turn.failedAt === null)
          )
            continue;
          const project = projects.get(thread.projectId);
          const path = thread.worktreePath ?? project?.workspaceRoot;
          // An unresolved active owner is not evidence that the checkout is idle.
          if (!path || (yield* fs.realPath(path)) === cwd) return false;
        }
        // A handoff can rebind a thread before its old provider session exits.
        // Keep that session's actual checkout excluded as well as the new binding.
        const threads = new Map(model.threads.map((thread) => [thread.id, thread]));
        for (const session of yield* provider.listSessions()) {
          const thread = threads.get(session.threadId);
          if (!session.activeTurnId && (!thread || !threadCheckoutHasUnsettledWork(thread)))
            continue;
          if (!session.cwd || (yield* fs.realPath(session.cwd)) === cwd) return false;
        }
        return true;
      });

    const head = (cwd: string) =>
      git
        .execute({
          operation: "ProjectAutoPull.head",
          cwd,
          args: ["rev-parse", "HEAD"],
        })
        .pipe(Effect.map((result) => result.stdout.trim()));

    const pull = (cwd: string, projectIds: ReadonlySet<ProjectId>) =>
      Effect.gen(function* () {
        if (!(yield* eligible(cwd, projectIds))) return;
        const status = yield* git.statusDetails(cwd);
        const reason = autoPullSkipReason(status);
        if (reason) {
          yield* Effect.logDebug("Automatic project pull skipped", { cwd, reason });
          return;
        }
        const expectedHead = yield* head(cwd);
        const current = yield* git.statusDetailsLocal(cwd);
        // User status preferences can hide untracked files or submodule changes.
        const workingTree = yield* git.execute({
          operation: "ProjectAutoPull.workingTree",
          cwd,
          args: ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
        });
        if (
          autoPullSkipReason(current) ||
          workingTree.stdout.trim().length > 0 ||
          current.branch !== status.branch ||
          current.upstreamRef !== status.upstreamRef ||
          (yield* head(cwd)) !== expectedHead ||
          !(yield* eligible(cwd, projectIds))
        )
          return;

        yield* git.execute({
          operation: "ProjectAutoPull.pull",
          cwd,
          args: [
            "-c",
            "merge.autostash=false",
            "-c",
            "rebase.autoStash=false",
            "pull",
            "--ff-only",
          ],
          timeoutMs: 30_000,
          // Network-bound background pull: keep it out of the short-command
          // pool (deadline unchanged) so concurrent auto-pulls cannot queue
          // status polls behind network I/O.
          bypassProcessPool: true,
        });
        yield* PubSub.publish(changes, cwd);
      });

    const attemptCanonical = (cwd: string, projectIds: ReadonlySet<ProjectId>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if ((failures.get(cwd)?.retryAt ?? 0) > now) return;
        yield* coordinator.tryWithCheckout(
          cwd,
          pull(cwd, projectIds).pipe(
            Effect.tap(() => Effect.sync(() => failures.delete(cwd))),
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const count = (failures.get(cwd)?.count ?? 0) + 1;
                const failedAt = yield* Clock.currentTimeMillis;
                failures.set(cwd, {
                  count,
                  retryAt: failedAt + Math.min(30_000 * 2 ** (count - 1), 300_000),
                });
                yield* Effect.logWarning("Automatic project pull failed", { cwd, cause });
              }),
            ),
          ),
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull lookup failed", { cause }),
        ),
      );

    const attempt = (rawCwd: string) =>
      Effect.gen(function* () {
        const projects = yield* enabledProjects;
        if (projects.length === 0) return;
        const cwd = yield* fs.realPath(rawCwd);
        const direct = projects.filter(
          (project) => project.workspaceRoot === rawCwd || project.workspaceRoot === cwd,
        );
        const ids =
          direct.length > 0
            ? new Set(direct.map((project) => project.id))
            : (yield* resolveEnabledProjects(projects)).get(cwd);
        if (ids) yield* attemptCanonical(cwd, ids);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull lookup failed", { cause }),
        ),
      );

    const start = Effect.gen(function* () {
      const subscription = yield* engine.acquireDomainEventSubscription;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (event) => event.type === "project.meta-updated" && event.payload.autoPull === true,
        ),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const model = yield* engine.getReadModel();
            const project = model.projects.find((entry) => entry.id === event.aggregateId);
            if (project) yield* attempt(project.workspaceRoot);
          }),
        ),
        Effect.forkScoped,
      );
      const roots = yield* resolveEnabledProjects(yield* enabledProjects);
      yield* Effect.forEach(roots, ([cwd, ids]) => attemptCanonical(cwd, ids), {
        concurrency: 4,
        discard: true,
      });
    });

    return { attempt, start, changes: Stream.fromPubSub(changes) };
  }),
).pipe(Layer.provideMerge(CheckoutCoordinatorLive));
