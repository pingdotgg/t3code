import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { makeUnifiedPushWatch } from "./unifiedPushWatch.ts";

const at = "2026-11-13T12:00:00.000Z";
const now = Date.parse(at);

const stateFor = (
  server: string,
  thread: string,
  phase: RelayAgentActivityState["phase"],
  overrides: Partial<RelayAgentActivityState> = {},
): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make(server),
  threadId: ThreadId.make(thread),
  projectTitle: "Project",
  threadTitle: `Thread ${thread}`,
  phase,
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: at,
  deepLink: `/threads/${server}/${thread}`,
  ...overrides,
});

const makeWatch = () => makeUnifiedPushWatch({ deviceId: "phone", userId: "unifiedpush" });

describe("unifiedPushWatch", () => {
  it("repaints the card from a snapshot without alerting", () => {
    const watch = makeWatch();
    const message = watch.applySnapshot(
      "a",
      [stateFor("a", "1", "waiting_for_approval"), stateFor("a", "2", "running")],
      now,
    );
    expect(message?.data).toMatchObject({
      t3_kind: "agent_activity",
      device_id: "phone",
      user_id: "unifiedpush",
      // AgentNotifications.userHash: SHA-256 of "<userId>:<deviceId>".
      user_hash: "b2a24f5ea88cad2c8a969be5869fdad74a5f2693561d8b9bdb86fc8dbb2ab17d",
      updated_at: String(now),
      active: "true",
      activity_active_count: "2",
    });
    expect(message?.data).not.toHaveProperty("alert_id");
    expect(message?.data).not.toHaveProperty("source");
    expect(watch.applySnapshot("a", [], now)).not.toHaveProperty("data.alert_id");
  });

  it("sends a fresh watch's first card even when idle, tagged with its source", () => {
    const watch = makeUnifiedPushWatch({ deviceId: "phone", userId: "unifiedpush", source: "a" });
    expect(watch.applySnapshot("a", [], now)?.data).toMatchObject({ active: "false", source: "a" });
    expect(watch.applySnapshot("a", [], now)).toBeNull();
  });

  it("alerts once per phase change", () => {
    const watch = makeWatch();
    watch.applySnapshot("a", [stateFor("a", "1", "running")], now);
    const approval = watch.applyThreadUpdate(
      "a",
      "1",
      stateFor("a", "1", "waiting_for_approval"),
      now,
    );
    expect(approval?.label).toBe("approval (a)");
    expect(approval?.data.alert_path).toBe("/threads/a/1");
    expect(
      watch.applyThreadUpdate("a", "1", stateFor("a", "1", "waiting_for_approval"), now),
    ).toBeNull();
    expect(
      watch.applyThreadUpdate(
        "a",
        "1",
        stateFor("a", "1", "waiting_for_approval", { headline: "Still waiting" }),
        now,
      ),
    ).toBeNull();
  });

  it("merges every server into one card", () => {
    const watch = makeWatch();
    watch.applySnapshot("a", [stateFor("a", "1", "running")], now);
    const message = watch.applySnapshot(
      "b",
      [stateFor("b", "2", "waiting_for_input"), stateFor("b", "3", "running")],
      now,
    );
    expect(message?.data).toMatchObject({
      activity_active_count: "3",
      activity_attention_count: "1",
      activity_title: "3 active agents · 1 needs attention",
    });
    expect(
      [message?.data.activity_line_0, message?.data.activity_line_1, message?.data.activity_line_2]
        .map((line) => line?.split("\t")[1])
        .toSorted(),
    ).toEqual(["Thread 1", "Thread 2", "Thread 3"]);
  });

  it("replaces only the reconnecting server's states", () => {
    const watch = makeWatch();
    watch.applySnapshot("a", [stateFor("a", "1", "running")], now);
    watch.applySnapshot("b", [stateFor("b", "2", "running")], now);
    const message = watch.applySnapshot("a", [stateFor("a", "1", "waiting_for_approval")], now);
    expect(message?.data).toMatchObject({ activity_active_count: "2" });
    expect(message?.data).not.toHaveProperty("alert_id");
    expect(
      watch.applyThreadUpdate("a", "1", stateFor("a", "1", "waiting_for_approval"), now),
    ).toBeNull();
  });

  it("sends one ended card when the last active thread finishes", () => {
    const watch = makeWatch();
    watch.applySnapshot("a", [stateFor("a", "1", "running")], now);
    const done = watch.applyThreadUpdate("a", "1", stateFor("a", "1", "completed"), now);
    expect(done?.data).toMatchObject({ active: "false", activity_phase: "completed" });
    expect(done?.data.alert_id).toBeDefined();
    expect(watch.applyThreadUpdate("a", "1", null, now)).toBeNull();
    expect(watch.applySnapshot("b", [], now)).toBeNull();
  });

  it("alerts once per credential failure streak and re-arms after a connection", () => {
    const watch = makeWatch();
    watch.applySnapshot("a", [stateFor("a", "1", "running")], now);
    const first = watch.serverRejected("b", now);
    expect(first?.data).toMatchObject({
      alert_path: "/",
      alert_title: "T3 push watcher cannot reach b",
      active: "true",
      activity_active_count: "1",
    });
    expect(watch.serverRejected("b", now + 1_000)).toBeNull();
    expect(watch.serverRejected("c", now)?.data.alert_id).not.toBe(first?.data.alert_id);
    watch.serverConnected("b");
    const next = watch.serverRejected("b", now + 2_000);
    expect(next?.data.alert_id).toBeDefined();
    expect(next?.data.alert_id).not.toBe(first?.data.alert_id);
  });

  it("stays under the payload cap with long titles", () => {
    const watch = makeWatch();
    const long = "Very long title ".repeat(40);
    watch.applySnapshot(
      "a",
      Array.from({ length: 5 }, (_, index) =>
        stateFor("a", String(index), "running", { threadTitle: long, projectTitle: long }),
      ),
      now,
    );
    const message = watch.applyThreadUpdate(
      "a",
      "0",
      stateFor("a", "0", "waiting_for_approval", { threadTitle: long, projectTitle: long }),
      now,
    );
    expect(message?.data.alert_id).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(message?.data)).length).toBeLessThanOrEqual(
      3800,
    );
  });
});
