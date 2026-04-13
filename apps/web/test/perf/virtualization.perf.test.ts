import { expect, test } from "vitest";

import { summarizeBrowserPerfMetrics } from "../../../../test/perf/support/artifact";
import { PERF_CATALOG_IDS } from "@t3tools/shared/perf/scenarioCatalog";
import { PERF_THRESHOLDS } from "../../../../test/perf/support/thresholds";
import { startPerfAppHarness, type PerfAppHarness } from "./appHarness";
import {
  ensureThreadRowVisible,
  measureThreadSwitch,
  scrollTimelineTo,
  waitForThreadRoute,
} from "./pagePerfHelpers";

test("virtualization stays bounded and heavy thread switches remain snappy", async () => {
  const thresholds = PERF_THRESHOLDS.local;
  let harness: PerfAppHarness | null = null;
  let finished = false;

  try {
    harness = await startPerfAppHarness({
      suite: "virtualization",
      seedScenarioId: "large_threads",
    });

    const heavyAThreadSummary = harness.seededState.threadSummaries.find(
      (thread) => thread.id === PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
    );
    const heavyBThreadSummary = harness.seededState.threadSummaries.find(
      (thread) => thread.id === PERF_CATALOG_IDS.largeThreads.heavyBThreadId,
    );
    const heavyAProjectTitle =
      heavyAThreadSummary?.projectTitle ?? PERF_CATALOG_IDS.largeThreads.heavyAProjectTitle;
    const heavyBProjectTitle =
      heavyBThreadSummary?.projectTitle ?? PERF_CATALOG_IDS.largeThreads.heavyBProjectTitle;
    const heavyThreadMessageCount = heavyAThreadSummary?.messageCount ?? 0;
    expect(heavyAThreadSummary).toBeDefined();
    expect(heavyBThreadSummary).toBeDefined();
    expect(heavyThreadMessageCount).toBeGreaterThanOrEqual(2_000);
    expect(heavyAThreadSummary?.turnCount ?? 0).toBeLessThan(100);
    expect(heavyBThreadSummary?.turnCount ?? 0).toBeLessThan(100);

    await ensureThreadRowVisible(
      harness.page,
      heavyAProjectTitle,
      PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
    );
    await harness.page
      .getByTestId(`thread-row-${PERF_CATALOG_IDS.largeThreads.heavyAThreadId}`)
      .click();
    await waitForThreadRoute(harness.page, {
      threadId: PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
      messageId: PERF_CATALOG_IDS.largeThreads.heavyATerminalMessageId,
    });
    await scrollTimelineTo(harness.page, "bottom");

    await ensureThreadRowVisible(
      harness.page,
      heavyBProjectTitle,
      PERF_CATALOG_IDS.largeThreads.heavyBThreadId,
    );
    await harness.page
      .getByTestId(`thread-row-${PERF_CATALOG_IDS.largeThreads.heavyBThreadId}`)
      .click();
    await waitForThreadRoute(harness.page, {
      threadId: PERF_CATALOG_IDS.largeThreads.heavyBThreadId,
      messageId: PERF_CATALOG_IDS.largeThreads.heavyBTerminalMessageId,
    });
    await scrollTimelineTo(harness.page, "bottom");

    await harness.resetBrowserMetrics();

    await measureThreadSwitch(harness, {
      actionName: "thread-switch-warmup-a",
      projectTitle: heavyAProjectTitle,
      threadId: PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
      messageId: PERF_CATALOG_IDS.largeThreads.heavyATerminalMessageId,
    });

    const mountedRows = await harness.sampleMountedRows("heavy-a-open");
    expect(mountedRows).toBeLessThanOrEqual(thresholds.maxMountedTimelineRows);

    const measuredTargets = [
      {
        actionName: "thread-switch-1",
        threadId: PERF_CATALOG_IDS.largeThreads.heavyBThreadId,
        messageId: PERF_CATALOG_IDS.largeThreads.heavyBTerminalMessageId,
      },
      {
        actionName: "thread-switch-2",
        threadId: PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
        messageId: PERF_CATALOG_IDS.largeThreads.heavyATerminalMessageId,
      },
      {
        actionName: "thread-switch-3",
        threadId: PERF_CATALOG_IDS.largeThreads.heavyBThreadId,
        messageId: PERF_CATALOG_IDS.largeThreads.heavyBTerminalMessageId,
      },
      {
        actionName: "thread-switch-4",
        threadId: PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
        messageId: PERF_CATALOG_IDS.largeThreads.heavyATerminalMessageId,
      },
      {
        actionName: "thread-switch-5",
        threadId: PERF_CATALOG_IDS.largeThreads.heavyBThreadId,
        messageId: PERF_CATALOG_IDS.largeThreads.heavyBTerminalMessageId,
      },
      {
        actionName: "thread-switch-6",
        threadId: PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
        messageId: PERF_CATALOG_IDS.largeThreads.heavyATerminalMessageId,
      },
    ] as const;

    for (const target of measuredTargets) {
      await measureThreadSwitch(harness, {
        actionName: target.actionName,
        projectTitle:
          target.threadId === PERF_CATALOG_IDS.largeThreads.heavyAThreadId
            ? heavyAProjectTitle
            : heavyBProjectTitle,
        threadId: target.threadId,
        messageId: target.messageId,
      });
      await harness.sampleMountedRows(`${target.actionName}-rows`);
    }

    await scrollTimelineTo(harness.page, "bottom");
    await harness.sampleMountedRows("scroll-start");
    await scrollTimelineTo(harness.page, "top");
    await harness.sampleMountedRows("scroll-top");
    await scrollTimelineTo(harness.page, "bottom");
    await harness.sampleMountedRows("scroll-bottom");

    const browserMetrics = await harness.snapshotBrowserMetrics();
    const summary = summarizeBrowserPerfMetrics(browserMetrics, {
      threadSwitchActionPrefix: "thread-switch",
    });

    expect(summary.threadSwitchP50Ms).not.toBeNull();
    expect(summary.threadSwitchP95Ms).not.toBeNull();
    expect(summary.threadSwitchP50Ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      thresholds.threadSwitchP50Ms,
    );
    expect(summary.threadSwitchP95Ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      thresholds.threadSwitchP95Ms,
    );
    expect(summary.maxMountedTimelineRows).toBeLessThanOrEqual(thresholds.maxMountedTimelineRows);
    expect(summary.maxLongTaskMs).toBeLessThanOrEqual(thresholds.maxLongTaskMs);
    expect(summary.maxRafGapMs).toBeLessThanOrEqual(thresholds.maxRafGapMs);

    await harness.finishRun({
      suite: "virtualization",
      scenarioId: "large_threads",
      thresholds,
      metadata: {
        heavyThreadMessageCount,
      },
      actionSummary: {
        threadSwitchActionPrefix: "thread-switch",
      },
    });
    finished = true;
  } finally {
    if (harness && !finished) {
      await harness.finishRun({
        suite: "virtualization",
        scenarioId: "large_threads",
        thresholds,
        metadata: {
          heavyThreadMessageCount: harness.seededState.threadSummaries.find(
            (thread) => thread.id === PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
          )?.messageCount,
        },
        actionSummary: {
          threadSwitchActionPrefix: "thread-switch",
        },
      });
    }
  }
});
