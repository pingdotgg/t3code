import type {
  DesktopAgentActivitySnapshotInput,
  DesktopAgentActivitySource,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createDesktopAgentActivityWriter,
  visibleDesktopAgentActivities,
} from "./desktopAgentActivityBridge";

const now = Date.parse("2026-08-10T20:00:00.000Z");
const snapshot: DesktopAgentActivitySnapshotInput = {
  schemaVersion: 1,
  generatedAt: "2026-08-10T20:00:00.000Z",
  activities: [],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function activity(
  phase: DesktopAgentActivitySource["phase"],
  updatedAt: string,
): DesktopAgentActivitySource {
  return {
    sourceId: "remote-env:thread-1",
    label: "Build Mac · Ship the bridge",
    phase,
    updatedAt,
  };
}

describe("visibleDesktopAgentActivities", () => {
  it("keeps active work regardless of the last thread update", () => {
    const result = visibleDesktopAgentActivities(
      [activity("running", "2026-08-10T10:00:00.000Z")],
      now,
    );

    expect(result).toHaveLength(1);
  });

  it("drops terminal work after the visibility window", () => {
    const result = visibleDesktopAgentActivities(
      [
        activity("completed", "2026-08-10T19:50:00.000Z"),
        activity("failed", "2026-08-10T19:40:00.000Z"),
      ],
      now,
    );

    expect(result.map((item) => item.phase)).toEqual(["completed"]);
  });
});

describe("desktop agent activity writer", () => {
  it("serializes publishes and coalesces queued snapshots", async () => {
    const firstPublish = deferred();
    const published: DesktopAgentActivitySnapshotInput[] = [];
    const writer = createDesktopAgentActivityWriter(
      {
        publishAgentActivitySnapshot: async (nextSnapshot) => {
          published.push(nextSnapshot);
          if (published.length === 1) await firstPublish.promise;
        },
      },
      () => {},
    );
    const secondSnapshot = { ...snapshot, generatedAt: "2026-08-10T20:00:01.000Z" };
    const latestSnapshot = { ...snapshot, generatedAt: "2026-08-10T20:00:02.000Z" };

    const firstIdle = writer.publish(snapshot);
    const secondIdle = writer.publish(secondSnapshot);
    const latestIdle = writer.publish(latestSnapshot);
    expect(published).toEqual([snapshot]);

    firstPublish.resolve();
    await Promise.all([firstIdle, secondIdle, latestIdle]);
    expect(published).toEqual([snapshot, latestSnapshot]);
  });

  it("serializes clear after an in-flight publish", async () => {
    const firstPublish = deferred();
    const operations: string[] = [];
    const writer = createDesktopAgentActivityWriter(
      {
        publishAgentActivitySnapshot: async () => {
          operations.push("publish");
          await firstPublish.promise;
        },
        clearAgentActivitySnapshot: async () => {
          operations.push("clear");
        },
      },
      () => {},
    );

    void writer.publish(snapshot);
    void writer.publish({ ...snapshot, generatedAt: "2026-08-10T20:00:01.000Z" });
    const cleared = writer.clear();
    expect(operations).toEqual(["publish"]);

    firstPublish.resolve();
    await cleared;
    expect(operations).toEqual(["publish", "clear"]);
  });
});
