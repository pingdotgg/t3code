import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { AutoReviewSettings, ModelSelection, ProjectId, ServerSettings } from "@t3tools/contracts";
import {
  clampAutoReviewPollIntervalMs,
  matchAutoReviewMention,
  resolveAutoReviewPolicy,
} from "@t3tools/shared/autoReview";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
import * as AutoReviewRunner from "./AutoReviewRunner.ts";

export interface AutoReviewProjectSnapshot {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly deletedAt?: string | null;
}

export class AutoReviewPoller extends Context.Service<
  AutoReviewPoller,
  {
    readonly tick: Effect.Effect<void>;
    readonly start: Effect.Effect<void>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/autoReview/AutoReviewPoller") {}

export interface AutoReviewPollerDeps {
  readonly getSettings: Effect.Effect<Pick<ServerSettings, "autoReview">, unknown>;
  readonly listProjects: Effect.Effect<ReadonlyArray<AutoReviewProjectSnapshot>, unknown>;
  readonly isGitHubProject: (cwd: string) => Effect.Effect<boolean, unknown>;
  readonly contextForJob: (
    job: {
      readonly projectId: string;
      readonly prNumber: number;
      readonly headSha: string;
    },
  ) => Effect.Effect<AutoReviewRunner.AutoReviewOriginContext, unknown>;
}

export const make = (deps: AutoReviewPollerDeps) =>
  Effect.gen(function* () {
    const store = yield* AutoReviewJobStore.AutoReviewJobStore;
    const github = yield* GitHubCli.GitHubCli;
    const runner = yield* AutoReviewRunner.AutoReviewRunner;
    const fiberRef = { current: null as Fiber.Fiber<void, never> | null };

    const tick: AutoReviewPoller["Service"]["tick"] = Effect.gen(function* () {
      const settings = yield* deps.getSettings.pipe(
        Effect.catch(() =>
          Effect.succeed({ autoReview: { enabled: false } as AutoReviewSettings }),
        ),
      );
      if (!settings.autoReview.enabled) {
        return;
      }

      const projects = yield* deps.listProjects.pipe(Effect.orElseSucceed(() => []));
      for (const project of projects) {
        if (project.deletedAt) {
          continue;
        }
        const policy = resolveAutoReviewPolicy(settings.autoReview, project.id);
        if (!policy.enabled) {
          continue;
        }

        const isGithub = yield* deps
          .isGitHubProject(project.workspaceRoot)
          .pipe(Effect.orElseSucceed(() => false));
        if (!isGithub) {
          continue;
        }

        const prs = yield* github
          .listRepositoryOpenPullRequests({
            cwd: project.workspaceRoot,
            limit: 50,
          })
          .pipe(Effect.orElseSucceed(() => []));

        for (const pr of prs) {
          const headSha = pr.headRefOid?.trim();
          if (!headSha) {
            continue;
          }

          if (policy.mode === "auto") {
            yield* store.enqueue({
              projectId: project.id as ProjectId,
              prNumber: pr.number,
              headSha,
              trigger: "open_or_push",
              modelSelection: policy.modelSelection as ModelSelection,
            });
            continue;
          }

          const comments = yield* github
            .listPullRequestIssueComments({
              cwd: project.workspaceRoot,
              reference: String(pr.number),
              limit: 50,
            })
            .pipe(Effect.orElseSucceed(() => []));

          const watermark = yield* store.getWatermark(project.id, pr.number);
          let newestId = watermark?.lastCommentId ?? null;
          let newestAt = watermark?.lastSeenAt ?? null;

          for (const comment of comments) {
            if (watermark?.lastCommentId && comment.id === watermark.lastCommentId) {
              continue;
            }
            if (matchAutoReviewMention(comment.body, policy.mentionHandle)) {
              const isNew = !watermark?.lastCommentId || comment.id !== watermark.lastCommentId;
              if (isNew) {
                yield* store.enqueue({
                  projectId: project.id as ProjectId,
                  prNumber: pr.number,
                  headSha,
                  trigger: "mention",
                  commentId: comment.id,
                  modelSelection: policy.modelSelection as ModelSelection,
                });
              }
            }
            newestId = comment.id;
            newestAt = comment.createdAt;
          }

          if (newestId || newestAt) {
            yield* store.setWatermark({
              projectId: project.id,
              prNumber: pr.number,
              lastCommentId: newestId,
              lastSeenAt: newestAt,
            });
          }
        }
      }

      yield* runner
        .drain(
          (job) => deps.contextForJob(job).pipe(Effect.orElseSucceed(() => ({ cwd: "", candidates: [] }))),
          settings.autoReview.concurrency,
        )
        .pipe(Effect.orElseSucceed(() => 0));
    }).pipe(Effect.orElseSucceed(() => undefined), Effect.asVoid);

    const start: AutoReviewPoller["Service"]["start"] = Effect.gen(function* () {
      yield* store.requeueRunning();
      if (fiberRef.current) {
        return;
      }
      const settings = yield* deps.getSettings.pipe(
        Effect.orElseSucceed(() => ({ autoReview: { pollInterval: Duration.seconds(60) } as AutoReviewSettings })),
      );
      const pollMs = clampAutoReviewPollIntervalMs(
        Duration.toMillis(settings.autoReview.pollInterval ?? Duration.seconds(60)),
      );
      const fiber = yield* Effect.forkDetach(
        Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(Duration.millis(pollMs))))),
      );
      fiberRef.current = fiber as Fiber.Fiber<void, never>;
    });

    const stop: AutoReviewPoller["Service"]["stop"] = Effect.gen(function* () {
      if (!fiberRef.current) {
        return;
      }
      yield* Fiber.interrupt(fiberRef.current).pipe(Effect.asVoid, Effect.orElseSucceed(() => undefined));
      fiberRef.current = null;
    });

    return AutoReviewPoller.of({ tick, start, stop });
  });

export const layer = (deps: AutoReviewPollerDeps) => Layer.effect(AutoReviewPoller, make(deps));
