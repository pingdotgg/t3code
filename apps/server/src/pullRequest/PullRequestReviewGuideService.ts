/**
 * Guided reviews: a maintainer-facing brief on a pull request, written by the environment's
 * source-control writer model. See `PullRequestReviewGuide` in contracts for what a guide is for.
 *
 * The model reads the change itself, read-only, from a disposable checkout of the head, so a
 * guide has no size limit. That takes minutes on a large change, so a run belongs to the server
 * rather than to the request that started it: Generate returns as soon as the run is under way
 * and readers watch its state through `get`.
 *
 * Generation is explicit and the result is stored per pull request, so opening a guide never
 * spends a model run. A push leaves the stored guide in place and the reader sees it as stale.
 *
 * @module pullRequest/PullRequestReviewGuideService
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  PullRequestOperationError,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReviewGuide,
  type PullRequestReviewGuideResult,
  type PullRequestReviewGuideRun,
  type PullRequestStack,
  ProjectId,
  type RepositoryIdentity,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import type { ReviewGuideStackLayer } from "@t3tools/provider-core/server/textGeneration";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import * as ServerConfig from "../config.ts";
import * as PullRequestReviewGuides from "../persistence/PullRequestReviewGuides.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";
import * as PullRequestService from "./PullRequestService.ts";
import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";
import { reviewGuideInputFromPullRequest } from "./pullRequestReviewGuideInput.ts";
import { normalizeReviewGuide, parseReviewGuideChange } from "./pullRequestReviewGuideNormalize.ts";

export class PullRequestReviewGuideService extends Context.Service<
  PullRequestReviewGuideService,
  {
    /** The stored guide, any run in progress, and the head now. Never runs a model. */
    readonly get: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestReviewGuideResult, PullRequestService.PullRequestError>;
    /**
     * Start writing a guide for the current head and return once it is under way. Joins a run
     * already going for that head. A stored guide stays readable until the new one replaces it,
     * so a reader can rewrite one after changing the guide model or instructions. `started` says
     * whether this call began the run or joined one already going.
     */
    readonly generate: (
      input: PullRequestRef,
    ) => Effect.Effect<
      PullRequestReviewGuideResult & { readonly started: boolean },
      PullRequestService.PullRequestError
    >;
  }
>()("t3/pullRequest/PullRequestReviewGuideService") {}

const keyString = (key: ThreadPullRequestKey) => `${key.host}/${key.repository}#${key.number}`;

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const guides = yield* PullRequestReviewGuides.PullRequestReviewGuideRepository;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  // Runs outlive the request that started them and end with the server.
  const serviceScope = yield* Effect.scope;
  // In memory on purpose: a restart drops a run in progress, and a reader presses Generate again.
  const runs = yield* Ref.make<ReadonlyMap<string, PullRequestReviewGuideRun>>(new Map());
  // Names each run's private git refs; unique for the server's lifetime, like the runs map.
  let runCounter = 0;
  // Claiming a run and storing a finished guide take turns, so a run that still owns its pull
  // request when it checks is the one whose guide is stored: a newer claim cannot land between.
  const ownership = yield* Semaphore.make(1);

  const keyFor = Effect.fn("PullRequestReviewGuideService.keyFor")(function* (
    input: PullRequestRef,
  ) {
    const project = Option.getOrUndefined(
      yield* projects.getShell(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const key = pullRequestSyncKey(input, project?.repositoryIdentity ?? undefined);
    if (key === null || project === undefined) {
      return yield* new PullRequestOperationError({
        operation: "reviewGuide",
        detail: "Could not identify this pull request's host.",
      });
    }
    return { key, workspaceRoot: project.workspaceRoot, identity: project.repositoryIdentity };
  });

  /**
   * A guide reads the change in a checkout fetched from the project's own remote, so the pull
   * request has to be in that repository. One from another repository is refused rather than
   * measured against commits that are not its own.
   */
  const requireOwnRepository = Effect.fn("PullRequestReviewGuideService.requireOwnRepository")(
    function* (key: ThreadPullRequestKey, identity: RepositoryIdentity | null | undefined) {
      const own =
        identity == null
          ? null
          : pullRequestSyncKey(
              {
                projectId: ProjectId.make("own"),
                number: key.number,
                repository: sourceControlRepositorySelector(identity) ?? "",
              },
              identity,
            );
      if (own === null || own.host !== key.host || own.repository !== key.repository) {
        return yield* new PullRequestOperationError({
          operation: "generateReviewGuide",
          detail:
            "Guides are written from this project's checkout, and this pull request is in another repository. Write it from a project that is a checkout of that repository.",
        });
      }
    },
  );

  const readStored = (key: ThreadPullRequestKey) =>
    guides.get(key).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "reviewGuide",
            detail: "Could not read the stored review guide.",
            cause,
          }),
      ),
      Effect.map(Option.getOrNull),
    );

  const get: PullRequestReviewGuideService["Service"]["get"] = Effect.fn(
    "PullRequestReviewGuideService.get",
  )(function* (input) {
    const { key } = yield* keyFor(input);
    const [guide, detail, current] = yield* Effect.all(
      [readStored(key), pullRequests.detail(input), Ref.get(runs)],
      { concurrency: "unbounded" },
    );
    return {
      guide,
      run: current.get(keyString(key)) ?? null,
      currentHeadSha: detail.headSha ?? null,
    };
  });

  /**
   * A detached checkout of the head beside the project, removed when the run ends. Fetched by
   * commit rather than by branch so a fork's head and a branch checked out elsewhere both work,
   * and so the checkout is exactly what the host reported.
   */
  const checkoutHead = Effect.fn("PullRequestReviewGuideService.checkoutHead")(function* (
    workspaceRoot: string,
    detail: PullRequestDetail,
    headSha: string,
    stack: PullRequestStack | null,
    runId: string,
  ) {
    const remote = yield* git.resolvePrimaryRemoteName(workspaceRoot);
    const fetch = (args: ReadonlyArray<string>) =>
      git.execute({
        operation: "PullRequestReviewGuideService.fetch",
        cwd: workspaceRoot,
        args: ["fetch", "--quiet", "--no-tags", remote, ...args],
        timeoutMs: 5 * 60_000,
      });
    // The base branch is what the change is measured from; the head commit is the change. Hosts
    // that do not serve an unadvertised commit still serve their pull refs, which GitHub and
    // Forgejo name the same way.
    // The host names the base branch. A name git rejects, or one that would change the refspec
    // (a leading `+`, a `:`), is refused before it reaches `git fetch`.
    yield* git
      .execute({
        operation: "PullRequestReviewGuideService.checkBaseBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", "--branch", detail.baseBranch],
      })
      .pipe(
        Effect.filterOrFail(
          () => !detail.baseBranch.startsWith("+") && !detail.baseBranch.includes(":"),
          () =>
            new PullRequestOperationError({
              operation: "generateReviewGuide",
              detail: "The pull request's base branch name is not one git can fetch.",
            }),
        ),
      );
    // Fetched into a ref of this run's own: FETCH_HEAD is shared by every fetch in the
    // workspace, so a concurrent run could otherwise measure this change from its base.
    const baseRef = `refs/t3/review-guide/${runId}/base`;
    yield* fetch([`+refs/heads/${detail.baseBranch}:${baseRef}`]);
    yield* Effect.addFinalizer(() =>
      git
        .execute({
          operation: "PullRequestReviewGuideService.dropBaseRef",
          cwd: workspaceRoot,
          args: ["update-ref", "-d", baseRef],
        })
        .pipe(Effect.ignore({ log: true })),
    );
    const baseTip = yield* git.resolveCommit({ cwd: workspaceRoot, revision: baseRef });
    const fetchHead = (number: number, sha: string) =>
      fetch([sha]).pipe(Effect.catch(() => fetch([`refs/pull/${number}/head`])));
    yield* fetchHead(detail.number, headSha);
    // The other layers of a stack are context the model may read across a seam. A layer that
    // cannot be fetched is still named in the prompt, without a head to read.
    const layers: ReadonlyArray<ReviewGuideStackLayer> = yield* Effect.forEach(
      stack?.layers ?? [],
      (layer) => {
        const described = { number: layer.number, title: layer.title ?? null, state: layer.state };
        if (layer.number === detail.number) return Effect.succeed({ ...described, headSha });
        const sha = layer.headSha;
        if (sha === undefined) return Effect.succeed({ ...described, headSha: null });
        return fetchHead(layer.number, sha).pipe(
          Effect.andThen(git.resolveCommit({ cwd: workspaceRoot, revision: sha })),
          Effect.as({ ...described, headSha: sha }),
          Effect.orElseSucceed(() => ({ ...described, headSha: null })),
        );
      },
      { concurrency: 4 },
    );
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      directory: config.worktreesDir,
      prefix: "review-guide-",
    });
    const path = `${directory}/checkout`;
    yield* git.execute({
      operation: "PullRequestReviewGuideService.addWorktree",
      cwd: workspaceRoot,
      args: ["worktree", "add", "--detach", "--quiet", path, headSha],
      timeoutMs: 5 * 60_000,
    });
    yield* Effect.addFinalizer(() =>
      git
        .removeWorktree({ cwd: workspaceRoot, path, force: true })
        .pipe(Effect.ignore({ log: true })),
    );
    // Measured from where the head left the base, so a stacked change is briefed alone rather
    // than with everything below it that the base has not taken yet.
    const mergeBase = yield* git.execute({
      operation: "PullRequestReviewGuideService.mergeBase",
      cwd: path,
      args: ["merge-base", baseTip.commitSha, "HEAD"],
    });
    return { path, baseCommit: mergeBase.stdout.trim(), stack: layers };
  });

  /** The changed paths and their hunks, which a generated guide is held to. */
  const readChange = Effect.fn("PullRequestReviewGuideService.readChange")(function* (
    cwd: string,
    baseCommit: string,
  ) {
    const diff = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "PullRequestReviewGuideService.readChange",
          cwd,
          // Fixed prefixes: a user's diff.noPrefix or custom prefixes would hide the headers the
          // parser reads.
          args: [
            "-c",
            "core.quotePath=false",
            "diff",
            ...PATCH_RENDER_PREFIX_ARGS,
            ...args,
            `${baseCommit}...HEAD`,
          ],
          timeoutMs: 60_000,
          // Hunk headers only, but a large change still has many of them.
          maxOutputBytes: 64 * 1024 * 1024,
        })
        .pipe(Effect.map((result) => result.stdout));
    const [nameOnly, patch] = yield* Effect.all(
      [diff(["--name-only", "-z"]), diff(["--unified=0", "--no-color", "--no-ext-diff"])],
      { concurrency: "unbounded" },
    );
    return parseReviewGuideChange(nameOnly, patch);
  });

  const write = Effect.fn("PullRequestReviewGuideService.write")(function* (
    input: PullRequestRef,
    key: ThreadPullRequestKey,
    workspaceRoot: string,
    detail: PullRequestDetail,
    headSha: string,
    runId: string,
    owns: Effect.Effect<boolean>,
  ) {
    const [activity, settings, providers, stack] = yield* Effect.all(
      [
        pullRequests.activity(input),
        serverSettings.getSettings,
        providerRegistry.getProviders,
        // A guide without its stack is still a guide; the stack only adds seams to point at.
        pullRequests.stack(input).pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    const projectSettings = resolveProjectSettings(settings, input.projectId).settings;
    const modelSelection = ServerSettings.resolveReviewGuideModelSelection(
      projectSettings,
      providers,
    );
    // The checkout lives only as long as the model is reading it. The change's hunks are read
    // from it too, so the guide can be held to the lines the change actually touched.
    const { generated, change } = yield* checkoutHead(
      workspaceRoot,
      detail,
      headSha,
      stack,
      runId,
    ).pipe(
      Effect.flatMap((checkout) =>
        Effect.all(
          {
            generated: textGeneration.generateReviewGuide({
              ...reviewGuideInputFromPullRequest(detail, activity, checkout.baseCommit),
              cwd: checkout.path,
              modelSelection,
              instructions: projectSettings.reviewGuideInstructions,
              stack: checkout.stack,
            }),
            change: readChange(checkout.path, checkout.baseCommit),
          },
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
    );
    const guide: PullRequestReviewGuide = {
      headSha,
      generatedAt: yield* nowIso,
      modelSelection,
      ...normalizeReviewGuide(generated, change),
    };
    // A newer run for this pull request, say after a push, owns its guide now; this one's result
    // is for an older head and is dropped rather than written over it.
    yield* ownership.withPermits(1)(
      Effect.gen(function* () {
        if (yield* owns) yield* guides.put(key, guide);
      }),
    );
  });

  /** What a reader is told when a run fails; the full cause goes to the log. */
  const failureDetail = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.squash(cause);
    if (error instanceof Error && "detail" in error && typeof error.detail === "string") {
      return error.detail;
    }
    return "The review guide could not be written.";
  };

  const generate: PullRequestReviewGuideService["Service"]["generate"] = Effect.fn(
    "PullRequestReviewGuideService.generate",
  )(function* (input) {
    // A beta the server owns, so every client and agent sees the same answer.
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "generateReviewGuide",
            detail: "Could not read the server settings.",
            cause,
          }),
      ),
    );
    if (!settings.reviewGuidesEnabled) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "Review guides are off. Turn them on in Settings → Source Control.",
      });
    }
    const { key, workspaceRoot, identity } = yield* keyFor(input);
    yield* requireOwnRepository(key, identity);
    const runKey = keyString(key);
    // A press asks for the head as it is now, not a read shared from the last minute, so a guide
    // is never started for a commit the pull request has already moved past.
    yield* pullRequests.invalidate({ reference: input });
    const [detail, stored] = yield* Effect.all([pullRequests.detail(input), readStored(key)], {
      concurrency: "unbounded",
    });
    const currentHeadSha = detail.headSha ?? null;
    if (currentHeadSha === null) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "This host did not report the pull request's head commit.",
      });
    }
    const running: PullRequestReviewGuideRun = {
      _tag: "Running",
      headSha: currentHeadSha,
      startedAt: yield* nowIso,
    };
    // Claimed atomically, so two readers pressing Generate start one run between them. The head
    // is read again under the claim: a press that read an older head before a push must not
    // replace a run another press started for the new one, so it asks to be pressed again.
    const claimed = yield* ownership.withPermits(1)(
      pullRequests.detail(input).pipe(
        Effect.flatMap((latest) =>
          (latest.headSha ?? null) !== currentHeadSha
            ? Effect.fail(
                new PullRequestOperationError({
                  operation: "generateReviewGuide",
                  detail: "The pull request changed while the guide was starting. Try again.",
                }),
              )
            : Ref.modify(runs, (current) => {
                const existing = current.get(runKey);
                if (existing?._tag === "Running" && existing.headSha === currentHeadSha) {
                  return [existing, current] as const;
                }
                return [running, new Map(current).set(runKey, running)] as const;
              }),
        ),
      ),
    );
    if (claimed !== running) return { guide: stored, run: claimed, currentHeadSha, started: false };

    // The run is identified by its own Running value: a later claim replaces it, and from then
    // on this run's completion leaves the newer run's state and guide alone.
    const owns = Ref.get(runs).pipe(Effect.map((current) => current.get(runKey) === running));
    const finish = (next: PullRequestReviewGuideRun | null) =>
      Ref.update(runs, (current) => {
        if (current.get(runKey) !== running) return current;
        const updated = new Map(current);
        if (next === null) updated.delete(runKey);
        else updated.set(runKey, next);
        return updated;
      });
    const runId = `${runCounter++}`;
    yield* write(input, key, workspaceRoot, detail, currentHeadSha, runId, owns).pipe(
      Effect.andThen(finish(null)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? finish(null)
          : Effect.logWarning("Review guide generation failed", {
              key: runKey,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(nowIso),
              Effect.flatMap((failedAt) =>
                finish({
                  _tag: "Failed",
                  headSha: currentHeadSha,
                  failedAt,
                  detail: failureDetail(cause),
                }),
              ),
            ),
      ),
      Effect.forkIn(serviceScope),
    );
    return { guide: stored, run: running, currentHeadSha, started: true };
  });

  return PullRequestReviewGuideService.of({ get, generate });
});

export const layer = Layer.effect(PullRequestReviewGuideService, make);
