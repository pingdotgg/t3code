import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  EventId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ServerSettings as ContractServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";






import { NOW_MS, DAY_MS, at, type SettlementShell, shell, persistedLink, type AutoSettleCommand, testCrypto, makeProject, makeThread, type SettlementSnapshot, makeSnapshot, makePullRequestSummary, makeBranchPullRequest, type HarnessOptions, makeHarness, startHarness, PROJECT_ID, NOW } from "./ThreadSettlementService-fixtures.testkit.ts";
describe("ThreadSettlementServiceV2 worker", () => {
  it.effect("skips settings and PR decisions for recent branchless threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const threads = Array.from({ length: 32 }, (_, index) =>
          makeThread(`recent-${index}`, {
            updatedAt: DateTime.makeUnsafe(NOW),
            latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS),
          }),
        );
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(threads),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          assert.deepEqual(yield* Ref.get(fixture.commands), []);
          assert.deepEqual(yield* Ref.get(fixture.branchCalls), []);
          assert.equal(yield* Ref.get(fixture.settingsReadCount), 2);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          assert.deepEqual(
            new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
            new Set(threads.map((thread) => thread.id)),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
  it.effect("settles a merged pull request stored only in the thread links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("merged-link", {
          pullRequests: [
            {
              host: "example.test",
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
              source: "manual",
              linkedAt: "2026-08-20T00:00:00.000Z",
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
              },
              stack: null,
            },
          ],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles an idle thread with an open persisted link on the inactivity sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("open-link", {
          pullRequests: [persistedLink("open", DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"))],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: 3,
            sidebarAutoSettleKeepPullRequests: false,
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles only the project opted in while environment settlement is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("project-opt-in", {
          latestRunCompletedAt: DateTime.makeUnsafe("2026-08-25T00:00:00.000Z"),
        });
        const other = makeThread("environment-off", { projectId: ProjectId.make("other-project") });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread, other]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleAfterDays: 2 } },
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands.map((command) => command.threadId)).toEqual([thread.id]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("stops settling the rest of a sweep once auto-settlement is turned off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        // Sweeps settle 8 threads at a time, so the ninth starts after a dispatch turned it off.
        const threads = Array.from({ length: 9 }, (_, index) => makeThread(`idle-${index}`));
        let disable: Effect.Effect<unknown> = Effect.void;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(threads),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
          onDispatch: () => disable,
        });
        disable = fixture.updateSettings({ sidebarAutoSettleAfterDays: null });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const settled = (yield* Ref.get(fixture.commands)).map((command) => command.threadId);
          expect(settled).not.toContain(threads[8]!.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("looks up a branch in its worktree only while the worktree has .git", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("linked-worktree", {
              branch: "linked",
              worktreePath: "/worktrees/linked",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
            // A folder that outlived its .git makes git fail with not_a_repository.
            makeThread("emptied-worktree", {
              branch: "emptied",
              worktreePath: "/worktrees/emptied",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
          ]),
          existingWorktreePaths: [
            "/worktrees/linked",
            "/worktrees/linked/.git",
            "/worktrees/emptied",
          ],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          const cwdByBranch = Object.fromEntries(
            (yield* Ref.get(fixture.branchCalls)).map((call) => [call.branch, call.cwd]),
          );
          expect(cwdByBranch).toEqual({
            linked: "/worktrees/linked",
            emptied: "/workspace/project",
          });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("does not settle a thread whose worktree cannot be checked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("unreadable-worktree", {
                branch: "unreadable",
                worktreePath: "/worktrees/unreadable",
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              }),
              // A merged linked pull request still needs the branch recheck before settling.
              makeThread("unreadable-linked-worktree", {
                branch: "feature",
                worktreePath: "/worktrees/unreadable-linked",
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
                linkedPullRequest: {
                  projectId: PROJECT_ID,
                  repository: "owner/repository",
                  number: 41,
                  url: "https://example.test/owner/repository/pull/41",
                },
              }),
              makeThread("readable-worktree", {
                branch: "readable",
                worktreePath: "/worktrees/readable",
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              }),
            ],
            [
              {
                ...makeProject(),
                repositoryIdentity: {
                  canonicalKey: "example.test/owner/repository",
                  locator: {
                    source: "git-remote",
                    remoteName: "origin",
                    remoteUrl: "https://example.test/owner/repository.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "owner",
                  name: "repository",
                },
              },
            ],
          ),
          existingWorktreePaths: ["/worktrees/readable", "/worktrees/readable/.git"],
          unreadablePaths: ["/worktrees/unreadable/.git", "/worktrees/unreadable-linked/.git"],
          pullRequestSummary: (input) =>
            Effect.succeed({
              ...makePullRequestSummary({ ...input, state: "merged" }),
              mergedAt: NOW,
            }),
          branchPullRequest: (input) =>
            input.cwd.startsWith("/worktrees/unreadable")
              ? Effect.die(new Error("git: permission denied"))
              : Effect.succeed(makeBranchPullRequest("merged")),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            ThreadId.make("readable-worktree"),
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates immediately after a pull request merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const periodicLookupStarted = yield* Deferred.make<void>();
        const releasePeriodicLookup = yield* Deferred.make<void>();
        const mergedThreadSettled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "Owner/Repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("slow-periodic-lookup", {
              branch: "another-feature",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
          ]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Deferred.await(periodicLookupStarted);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergedThreadSettled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          yield* Deferred.succeed(releasePeriodicLookup, undefined);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles a merged thread when its background work ends, during a slow full sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const periodicLookupStarted = yield* Deferred.make<void>();
        const releasePeriodicLookup = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const mergedLink: NonNullable<SettlementShell["pullRequests"]>[number] = {
          ...persistedLink("open", DateTime.makeUnsafe("2026-08-20T00:00:00.000Z")),
          snapshot: {
            state: "merged",
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: NOW,
            syncedAt: NOW,
            mergedAt: NOW,
          },
        };
        const waiting = makeThread("waiting-on-subagent", {
          pullRequests: [mergedLink],
          pendingBackgroundTasks: [{ taskId: "child", kind: "subagent", description: "Review" }],
        });
        const slow = makeThread("slow-periodic-lookup", {
          branch: "another-feature",
          latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([waiting, slow]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(settled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Deferred.await(periodicLookupStarted);

          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([{ ...waiting, pendingBackgroundTasks: [] }, slow]),
          );
          yield* fixture.publishEvent({
            type: "run.background-work-cancelled",
            id: EventId.make("event:background-ended"),
            threadId: waiting.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: { runId: RunId.make("run:waiting"), restartCancelledBackgroundWork: [] },
          });
          yield* Deferred.await(settled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [waiting.id],
          );
          yield* Deferred.succeed(releasePeriodicLookup, undefined);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles a stopped thread while another thread's lookup is slow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const slowLookupStarted = yield* Deferred.make<void>();
        const releaseSlowLookup = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const recent = DateTime.makeUnsafe("2026-08-27T00:00:00.000Z");
        const slow = makeThread("slow-lookup", { branch: "feature", latestUserMessageAt: recent });
        const merged = makeThread("merged", {
          latestUserMessageAt: recent,
          pullRequests: [
            {
              ...persistedLink("open", recent),
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
              },
            },
          ],
          pendingBackgroundTasks: [{ taskId: "child", kind: "subagent", description: "Review" }],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([slow, merged]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(slowLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSlowLookup)),
                      Effect.as(makeBranchPullRequest("open")),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(settled, undefined),
        });
        const backgroundEnded = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
          type: "run.background-work-cancelled",
          id: EventId.make(`event:background-ended:${threadId}`),
          threadId,
          occurredAt: DateTime.makeUnsafe(NOW),
          payload: { runId: RunId.make(`run:${threadId}`), restartCancelledBackgroundWork: [] },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(backgroundEnded(slow.id));
          yield* Deferred.await(slowLookupStarted);
          // More events for the slow thread coalesce into one more pass, not more sweeps.
          for (let index = 0; index < 9; index++) {
            yield* fixture.publishEvent(backgroundEnded(slow.id));
          }

          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([slow, { ...merged, pendingBackgroundTasks: [] }]),
          );
          yield* fixture.publishEvent(backgroundEnded(merged.id));
          yield* Deferred.await(settled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [merged.id],
          );
          yield* Deferred.succeed(releaseSlowLookup, undefined);
          yield* reactor.drain;
          // The startup sweep, the first per-thread sweep, and one coalesced rerun.
          assert.strictEqual(yield* Ref.get(branchLookupCount), 3);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles an unlinked branch thread its agent merged from a shell, past the cache", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const settled = yield* Deferred.make<void>();
        const thread = makeThread("shell-merged", {
          branch: "saved-feature",
          latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          // The host already merged it; only a fresh read sees that past the cached open lookup.
          branchPullRequest: (_input, lookupOptions) =>
            Effect.succeed(makeBranchPullRequest(lookupOptions?.refresh ? "merged" : "open")),
          onDispatch: () => Deferred.succeed(settled, undefined),
        });
        const at = DateTime.makeUnsafe(NOW);
        const runId = RunId.make("run:shell-merged");
        const runEnded: OrchestrationV2DomainEvent = {
          type: "run.background-work-cancelled",
          id: EventId.make("event:shell-merged:run-ended"),
          threadId: thread.id,
          occurredAt: at,
          payload: { runId, restartCancelledBackgroundWork: [] },
        };

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(runEnded);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* fixture.publishEvent({
            type: "turn-item.updated",
            id: EventId.make("event:shell-merged:command"),
            threadId: thread.id,
            runId,
            occurredAt: at,
            payload: {
              id: TurnItemId.make("item:shell-merged:command"),
              threadId: thread.id,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              type: "command_execution",
              input: "gh pr merge 42 --squash",
            },
          });
          yield* Deferred.await(settled);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [thread.id],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "settles branch threads on a pull request merge without waiting for the next sweep",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const state = yield* Ref.make<"open" | "merged">("open");
          const mergedThreadSettled = yield* Deferred.make<void>();
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("branch-thread", {
                branch: "saved-feature",
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              }),
            ]),
            branchPullRequest: () => Ref.get(state).pipe(Effect.map(makeBranchPullRequest)),
            onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
          });

          yield* Effect.gen(function* () {
            const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), []);

            yield* Ref.set(state, "merged");
            yield* fixture.publishMerge;
            yield* Deferred.await(mergedThreadSettled);

            assert.deepStrictEqual(
              (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
              [ThreadId.make("branch-thread")],
            );
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), ["/workspace/project"]);
            yield* reactor.drain;
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("a merge does not settle threads linked to an unrelated pull request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const mergedThreadSettled = yield* Deferred.make<void>();
        const mergeLookupStarted = yield* Deferred.make<void>();
        const releaseMergeLookup = yield* Deferred.make<void>();
        const lookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("unrelated-linked", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 99,
                url: "https://example.test/owner/repository/pull/99",
              },
            }),
          ]),
          pullRequestSummary: (input) =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 3 ? Deferred.succeed(mergeLookupStarted, undefined) : Effect.void,
              ),
              Effect.tap((count) =>
                count === 3 ? Deferred.await(releaseMergeLookup) : Effect.void,
              ),
              Effect.map(() => makePullRequestSummary({ ...input, state: "open" })),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergeLookupStarted);
          yield* Deferred.await(mergedThreadSettled);
          yield* Deferred.succeed(releaseMergeLookup, undefined);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls))
              .map((call) => call.number)
              .toSorted((left, right) => left - right),
            [42, 99, 99],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
