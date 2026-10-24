import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
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
import { sourceControlClients } from "../sourceControl/sourceControlClients.ts";

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

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/;

export class PullRequestReviewGuideService extends Context.Service<
  PullRequestReviewGuideService,
  {
    readonly get: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestReviewGuideResult, PullRequestService.PullRequestError>;
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
  const serviceScope = yield* Effect.scope;
  const runs = yield* Ref.make<ReadonlyMap<string, PullRequestReviewGuideRun>>(new Map());
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

  const requireOwnRepository = Effect.fn("PullRequestReviewGuideService.requireOwnRepository")(
    function* (key: ThreadPullRequestKey, identity: RepositoryIdentity | null | undefined) {
      const own =
        identity == null
          ? null
          : pullRequestSyncKey(
              {
                projectId: ProjectId.make("own"),
                number: key.number,
                repository: sourceControlClients.repositorySelector(identity) ?? "",
              },
              identity,
            );
      if (
        identity == null ||
        own === null ||
        own.host !== key.host ||
        own.repository !== key.repository
      ) {
        return yield* new PullRequestOperationError({
          operation: "generateReviewGuide",
          detail:
            "Guides are written from this project's checkout, and this pull request is in another repository. Write it from a project that is a checkout of that repository.",
        });
      }
      return identity.locator;
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

  const checkoutHead = Effect.fn("PullRequestReviewGuideService.checkoutHead")(function* (
    workspaceRoot: string,
    locator: RepositoryIdentity["locator"],
    detail: PullRequestDetail,
    headSha: string,
    stack: PullRequestStack | null,
    runId: string,
  ) {
    // Identity names can be stale; match effective fetch URLs, including insteadOf rewrites.
    const names = yield* git
      .execute({
        operation: "PullRequestReviewGuideService.listRemotes",
        cwd: workspaceRoot,
        args: ["remote"],
      })
      .pipe(Effect.map((result) => result.stdout.split("\n").filter((name) => name.length > 0)));
    const remote = yield* Effect.findFirst(
      [locator.remoteName, ...names.filter((name) => name !== locator.remoteName)],
      (name) =>
        git
          .execute({
            operation: "PullRequestReviewGuideService.remoteUrl",
            cwd: workspaceRoot,
            args: ["remote", "get-url", "--", name],
          })
          .pipe(
            Effect.map((result) => result.stdout.trim() === locator.remoteUrl),
            Effect.orElseSucceed(() => false),
          ),
    ).pipe(Effect.map(Option.getOrUndefined));
    if (remote === undefined) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "This project's checkout no longer has a remote for the pull request's repository.",
      });
    }
    const fetch = (args: ReadonlyArray<string>) =>
      git.execute({
        operation: "PullRequestReviewGuideService.fetch",
        cwd: workspaceRoot,
        args: ["fetch", "--quiet", "--no-tags", "--", remote, ...args],
        timeoutMs: 5 * 60_000,
      });
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
    const fetchHead = Effect.fn("PullRequestReviewGuideService.fetchHead")(function* (
      number: number,
      reportedSha: string,
      branch: string,
    ) {
      const sha = reportedSha.toLowerCase();
      if (!COMMIT_HASH_PATTERN.test(sha)) {
        return yield* new PullRequestOperationError({
          operation: "generateReviewGuide",
          detail: `The host reported a head for #${number} that is not a commit hash.`,
        });
      }
      // Not redundant: rev-parse prefers a branch or tag named like a short hash over the commit.
      const resolveHead = git.resolveCommit({ cwd: workspaceRoot, revision: sha }).pipe(
        Effect.filterOrFail(
          ({ commitSha }) => commitSha.startsWith(sha),
          ({ commitSha }) =>
            new PullRequestOperationError({
              operation: "generateReviewGuide",
              detail: `${sha} names ${commitSha} here, a branch or tag rather than the commit.`,
            }),
        ),
      );
      const fetchAndResolve = (ref: string) => fetch([ref]).pipe(Effect.andThen(resolveHead));
      const headRef = sourceControlClients.get(detail.provider).changeRequestHeadRef?.(number);
      const branchRef = `refs/heads/${branch}`;
      const checkBranch = git.execute({
        operation: "PullRequestReviewGuideService.checkHeadBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", branchRef],
      });
      const sources = [
        { source: "local objects", head: resolveHead },
        ...(sha.length === 40 || sha.length === 64
          ? [{ source: "the commit", head: fetchAndResolve(sha) }]
          : []),
        {
          source: `branch ${branch}`,
          head: checkBranch.pipe(Effect.andThen(fetchAndResolve(branchRef))),
        },
        ...(headRef === undefined ? [] : [{ source: headRef, head: fetchAndResolve(headRef) }]),
      ];
      const failures: Array<string> = [];
      for (const { source, head } of sources) {
        const result = yield* Effect.result(head);
        if (Result.isSuccess(result)) return result.success;
        failures.push(`${source}: ${result.failure.detail}`);
      }
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: `Could not find head ${sha} of #${number}. ${failures.join(" ")}`,
      });
    });
    const resolvedHead = yield* fetchHead(detail.number, headSha, detail.headBranch);
    const layers: ReadonlyArray<ReviewGuideStackLayer> = yield* Effect.forEach(
      stack?.layers ?? [],
      (layer) => {
        const described = { number: layer.number, title: layer.title ?? null, state: layer.state };
        if (layer.number === detail.number) return Effect.succeed({ ...described, headSha });
        const sha = layer.headSha;
        if (sha === undefined) return Effect.succeed({ ...described, headSha: null });
        return fetchHead(layer.number, sha, layer.headBranch).pipe(
          Effect.map(({ commitSha }) => ({ ...described, headSha: commitSha })),
          Effect.catch((error) =>
            Effect.logInfo("Review guide could not read a stack layer's head", {
              layer: layer.number,
              detail: error.detail,
            }).pipe(Effect.as({ ...described, headSha: null })),
          ),
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
      args: ["worktree", "add", "--detach", "--quiet", path, resolvedHead.commitSha],
      timeoutMs: 5 * 60_000,
    });
    yield* Effect.addFinalizer(() =>
      git
        .removeWorktree({ cwd: workspaceRoot, path, force: true })
        .pipe(Effect.ignore({ log: true })),
    );
    const mergeBase = yield* git.execute({
      operation: "PullRequestReviewGuideService.mergeBase",
      cwd: path,
      args: ["merge-base", baseTip.commitSha, "HEAD"],
    });
    return { path, baseCommit: mergeBase.stdout.trim(), stack: layers };
  });

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
    locator: RepositoryIdentity["locator"],
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
        pullRequests.stack(input).pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    const projectSettings = resolveProjectSettings(settings, input.projectId).settings;
    const modelSelection = ServerSettings.resolveReviewGuideModelSelection(
      projectSettings,
      providers,
      input.projectId,
    );
    const { generated, change } = yield* checkoutHead(
      workspaceRoot,
      locator,
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
    yield* ownership.withPermits(1)(
      Effect.gen(function* () {
        if (yield* owns) yield* guides.put(key, guide);
      }),
    );
  });

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
    const locator = yield* requireOwnRepository(key, identity);
    const runKey = keyString(key);
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
    yield* write(input, key, workspaceRoot, locator, detail, currentHeadSha, runId, owns).pipe(
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
