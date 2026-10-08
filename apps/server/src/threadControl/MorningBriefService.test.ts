import { TextGenerationError } from "@cz/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ForkDatabase from "../forkDatabase/ForkDatabase.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as MorningBriefService from "./MorningBriefService.ts";
import * as ThreadDigestService from "./ThreadDigestService.ts";
import {
  type BriefThread,
  briefGroups,
  briefOutcome,
  briefSince,
  plainLine,
  VISIT_GAP_MS,
  visitAfterOpen,
} from "./MorningBriefService.ts";

const HOUR = 60 * 60_000;

const thread = (overrides: Partial<BriefThread>): BriefThread => ({
  threadId: "t",
  title: "Thread",
  outcome: "done",
  project: "hll",
  errorClass: null,
  error: null,
  excerpt: null,
  ...overrides,
});

describe("morning brief", () => {
  it("covers everything since the visit before this one", () => {
    const now = 100 * HOUR;
    // Last visit ended last night; this morning's first open hasn't been marked yet.
    expect(briefSince({ seenAt: now - 10 * HOUR, previousSeenAt: now - 30 * HOUR }, now)).toBe(
      now - 10 * HOUR,
    );
    // Opening the feed starts a visit, and the brief keeps covering since last night.
    const visiting = visitAfterOpen({ seenAt: now - 10 * HOUR, previousSeenAt: null }, now);
    expect(visiting).toEqual({ seenAt: now, previousSeenAt: now - 10 * HOUR });
    expect(briefSince(visiting, now + 5 * 60_000)).toBe(now - 10 * HOUR);
    // Reloading or opening on the phone mid-visit doesn't empty it.
    const reopened = visitAfterOpen(visiting, now + 10 * 60_000);
    expect(reopened.previousSeenAt).toBe(now - 10 * HOUR);
    // Once the visit is over, the next brief starts where it ended.
    expect(briefSince(reopened, now + 10 * 60_000 + VISIT_GAP_MS)).toBe(now + 10 * 60_000);
  });

  it("starts from the last 14 hours, and never reaches back past 3 days", () => {
    const now = 1000 * HOUR;
    expect(briefSince({ seenAt: null, previousSeenAt: null }, now)).toBe(now - 14 * HOUR);
    expect(briefSince({ seenAt: now - 200 * HOUR, previousSeenAt: null }, now)).toBe(
      now - 72 * HOUR,
    );
  });

  it("calls an interrupted or cancelled run stopped, not failed", () => {
    expect(briefOutcome("interrupted")).toBe("stopped");
    expect(briefOutcome("cancelled")).toBe("stopped");
    expect(briefOutcome("failed")).toBe("failed");
    expect(briefOutcome("idle")).toBe("done");
    expect(briefOutcome("running")).toBeNull();
  });

  it("groups done work by project and failures by cause", () => {
    const groups = briefGroups([
      thread({ threadId: "a", project: "hll" }),
      thread({ threadId: "b", project: "czcode" }),
      thread({ threadId: "c", project: "hll" }),
      thread({ threadId: "d", outcome: "stopped" }),
      thread({ threadId: "e", outcome: "failed", errorClass: "usage_limit", error: "Limit hit" }),
      thread({ threadId: "f", outcome: "failed", errorClass: "usage_limit" }),
      thread({ threadId: "g", outcome: "failed", errorClass: null }),
    ]);
    expect(
      groups.map((group) => [group.label, group.action, group.threads.map((t) => t.threadId)]),
    ).toEqual([
      ["hll", "open", ["a", "c"]],
      ["czcode", "open", ["b"]],
      ["Usage limit", "retry", ["e", "f"]],
      ["Failed", "open", ["g"]],
      ["Stopped", "dismiss", ["d"]],
    ]);
    expect(groups.map(plainLine)).toEqual([
      "2 threads finished",
      "1 thread finished",
      "2 threads failed: Limit hit",
      "1 thread failed",
      "1 thread stopped before finishing",
    ]);
  });
});

const shell = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "p",
  title: `Thread ${id}`,
  status,
  archivedAt: null,
  deletedAt: null,
  activeRunId: null,
  lineage: { relationshipToParent: null },
  latestRunCompletedAt: DateTime.makeUnsafe(0),
  lastError: null,
  lastErrorClass: null,
  ...extra,
});

const briefLayer = (
  threads: ReadonlyArray<ReturnType<typeof shell>>,
  generate: TextGeneration.TextGeneration["Service"]["generateMorningBrief"],
) =>
  MorningBriefService.layer.pipe(
    Layer.provide(ForkDatabase.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cz-brief-" })),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: () => Effect.succeed({ threads, archivedThreads: [] }),
      } as never),
    ),
    Layer.provide(
      Layer.succeed(ProjectService.ProjectService, {
        snapshot: Effect.succeed({ projects: [{ id: "p", title: "SWE" }] }),
      } as never),
    ),
    Layer.provide(
      Layer.succeed(
        ThreadDigestService.ThreadDigestService,
        ThreadDigestService.ThreadDigestService.of({
          digests: (ids) =>
            Effect.succeed(
              ids.map((threadId) => ({
                threadId,
                excerpt: "Did it.",
                workingSubpath: "games/hll",
              })),
            ),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generateMorningBrief: generate,
      } as never),
    ),
    Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, {} as never)),
    Layer.provide(NodeServices.layer),
  );

describe("MorningBriefService", () => {
  it.effect("writes one line per group once, and reuses it until a thread ends", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const service = yield* MorningBriefService.MorningBriefService;
      const first = yield* service.brief;
      const second = yield* service.brief;
      expect(first.lines).toBe("written");
      expect(first.groups.map((group) => [group.kind, group.label, group.text])).toEqual([
        ["done", "hll", "Andras rigged in game"],
        ["stopped", "Stopped", "1 thread stopped before finishing"],
      ]);
      expect(second.groups).toEqual(first.groups);
      expect(calls).toBe(1);
    }).pipe(
      Effect.provide(
        briefLayer([shell("a", "completed"), shell("b", "interrupted")], () => {
          calls += 1;
          return Effect.succeed({ lines: new Map([["done:hll", "Andras rigged in game"]]) });
        }),
      ),
    );
  });

  it.effect("falls back to plain counts when the model fails", () =>
    Effect.gen(function* () {
      const brief = yield* (yield* MorningBriefService.MorningBriefService).brief;
      expect(brief.lines).toBe("plain");
      expect(brief.groups.map((group) => group.text)).toEqual([
        "1 thread failed: Usage limit reached",
      ]);
    }).pipe(
      Effect.provide(
        briefLayer(
          [
            shell("a", "failed", {
              lastError: "Usage limit reached",
              lastErrorClass: "usage_limit",
            }),
          ],
          () =>
            Effect.fail(
              new TextGenerationError({ operation: "generateMorningBrief", detail: "offline" }),
            ),
        ),
      ),
    ),
  );

  it.effect("answers with counts while the model is still writing", () =>
    Effect.gen(function* () {
      const service = yield* MorningBriefService.MorningBriefService;
      const fiber = yield* service.brief.pipe(Effect.forkChild);
      yield* TestClock.adjust("21 seconds");
      const brief = yield* Fiber.join(fiber);
      expect(brief.lines).toBe("pending");
      expect(brief.groups[0]?.text).toBe("1 thread finished");
    }).pipe(Effect.provide(briefLayer([shell("a", "idle")], () => Effect.never))),
  );
});
