import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ThreadId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";
import { sweepOnce } from "./ReviewThreadMergeArchiveReactor.ts";

const projectId = ProjectId.make("project-1");
const REPO = "owner/name";

const reviewThread = (id: string, number: number, state: "open" | "merged" = "open") =>
  ({
    id: ThreadId.make(id),
    projectId,
    parentThreadId: null,
    reviewSnapshot: { scope: "pull-request" },
    reviewResult: null,
    pullRequests: [
      {
        pullRequest: {
          url: `https://github.com/${REPO}/pull/${number}`,
          number,
          title: `Change ${number}`,
          state,
          baseBranch: "main",
          headBranch: "feature",
        },
        source: "agent",
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    pullRequest: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    latestTurn: null,
  }) as unknown as OrchestrationThread;

const readModel = (threads: ReadonlyArray<OrchestrationThread>) =>
  ({ projects: [], threads, workflowRuns: [] }) as unknown as OrchestrationReadModel;

const harness = ({
  threads,
  settings = { autoArchiveReviewThreadsOnMerge: true },
  mergedNumbers = [],
  failList = false,
}: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly settings?: Partial<ServerSettings>;
  readonly mergedNumbers?: ReadonlyArray<number>;
  readonly failList?: boolean;
}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const listCalls = yield* Ref.make<ReadonlyArray<{ readonly state: string }>>([]);
    const detailCalls = yield* Ref.make(0);
    const logs: Array<string> = [];

    const services = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(readModel(threads)),
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (previous) => [...previous, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
      } as unknown as OrchestrationEngineShape),
      Layer.succeed(ServerSettingsService, {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          ...settings,
        } satisfies ServerSettings),
      } as unknown as ServerSettingsShape),
      // No monitor: this suite exercises the provider fallback, which is the path a review
      // thread takes when automatic monitoring is off.
      Layer.succeed(PullRequestMonitorService, {
        status: () => Effect.succeed({ monitor: null, latestSnapshot: null }),
      } as never),
      Layer.succeed(PullRequestService, {
        list: (input: { readonly state: string }) =>
          Ref.update(listCalls, (previous) => [...previous, { state: input.state }]).pipe(
            Effect.andThen(
              failList
                ? Effect.fail(new Error("gh unavailable"))
                : Effect.succeed({
                    entries: mergedNumbers.map((number) => ({
                      host: "github.com",
                      projectId,
                      repository: REPO,
                      number,
                      title: `Change ${number}`,
                      url: `https://github.com/${REPO}/pull/${number}`,
                      state: "merged",
                    })),
                    truncated: false,
                  }),
            ),
          ),
        detail: () => Ref.update(detailCalls, (count) => count + 1).pipe(Effect.as(undefined)),
      } as never),
    );

    const capturingLogger = Logger.map(Logger.formatStructured, (entry) => {
      const text = entry.annotations.message;
      logs.push(typeof text === "string" ? text : (JSON.stringify(entry.message) ?? ""));
      return entry;
    });

    const run = Effect.suspend(() =>
      Effect.provide(sweepOnce, services).pipe(
        Effect.provide(Logger.layer([capturingLogger], { mergeWithExisting: false })),
        Effect.asVoid,
      ),
    );

    return { run, dispatched, listCalls, detailCalls, logs };
  });

describe("sweepOnce", () => {
  it.effect("archives a review thread whose pull request the project listing reports merged", () =>
    Effect.gen(function* () {
      const h = yield* harness({ threads: [reviewThread("root", 7)], mergedNumbers: [7] });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 1);
      assert.strictEqual(commands[0]?.type, "thread.archive");
    }),
  );

  it.effect("asks the provider once per project rather than once per pull request", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        threads: [reviewThread("a", 1), reviewThread("b", 2), reviewThread("c", 3)],
        mergedNumbers: [2],
      });
      yield* h.run;
      const calls = yield* Ref.get(h.listCalls);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.state, "merged");
      const details = yield* Ref.get(h.detailCalls);
      assert.strictEqual(details, 0);
    }),
  );

  it.effect("archives a recorded merge without asking the provider at all", () =>
    Effect.gen(function* () {
      const h = yield* harness({ threads: [reviewThread("root", 7, "merged")] });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 1);
      const calls = yield* Ref.get(h.listCalls);
      assert.strictEqual(calls.length, 0);
    }),
  );

  it.effect("does nothing while the setting is off", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        threads: [reviewThread("root", 7)],
        settings: { autoArchiveReviewThreadsOnMerge: false },
        mergedNumbers: [7],
      });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      const calls = yield* Ref.get(h.listCalls);
      assert.strictEqual(commands.length, 0);
      assert.strictEqual(calls.length, 0);
    }),
  );

  it.effect("logs and archives nothing when the provider read fails", () =>
    Effect.gen(function* () {
      const h = yield* harness({ threads: [reviewThread("root", 7)], failList: true });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      const logs = h.logs;
      assert.strictEqual(commands.length, 0);
      assert.isTrue(
        logs.some((line) => line.includes("review-thread-merge-archive")),
        `expected a sweep log line, saw ${JSON.stringify(logs)}`,
      );
    }),
  );

  it.effect("leaves a review thread alone while a turn is still running", () =>
    Effect.gen(function* () {
      const running = {
        ...reviewThread("root", 7),
        latestTurn: { turnId: "turn-1", state: "running", completedAt: null },
      } as unknown as OrchestrationThread;
      const h = yield* harness({ threads: [running], mergedNumbers: [7] });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 0);
    }),
  );
});
