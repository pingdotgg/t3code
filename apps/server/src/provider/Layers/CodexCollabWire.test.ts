/**
 * Codex multi-agent wire fixtures.
 *
 * The child-interception path is the highest-blast-radius code in the
 * subagent stack: it decides, per notification, whether traffic reaches the
 * parent timeline at all. Three shipped bugs came from that decision being
 * implicit (root thread registered as its own child; `error` and
 * `serverRequest/resolved` swallowed by a catch-all). These tests pin the
 * decision against a REAL capture rather than hand-written shapes.
 *
 * Fixture provenance: codex-cli 0.145.0 driven directly over stdio with
 * gpt-5.6-luna at low effort, prompting a two-child fan-out (alpha, beta).
 * See codexMultiAgentWire.json.
 */
import { assert, describe, it } from "vite-plus/test";

import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { routeCodexChildNotification } from "./CodexSessionRuntime.ts";

interface WireNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const notifications = fixture.notifications as ReadonlyArray<WireNotification>;
const rootThreadId = fixture.rootThreadId;
const childThreadIds = new Set(fixture.childThreadIds);

/** Mirrors readNotificationThreadId's addressing for the captured methods. */
function notificationThreadId(entry: WireNotification): string | undefined {
  const params = entry.params;
  const thread = params.thread;
  if (
    typeof thread === "object" &&
    thread !== null &&
    typeof (thread as { id?: unknown }).id === "string"
  ) {
    return (thread as { id: string }).id;
  }
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

function subAgentActivityItems(): ReadonlyArray<Record<string, unknown>> {
  return notifications.flatMap((entry) => {
    const item = entry.params.item;
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    return record.type === "subAgentActivity" ? [record] : [];
  });
}

describe("codex multi-agent wire capture", () => {
  it("captures a real two-child fan-out", () => {
    assert.equal(fixture.capturedWith.model, "gpt-5.6-luna");
    assert.equal(childThreadIds.size, 2);
    const paths = subAgentActivityItems().map((item) => item.agentPath);
    assert.include(paths, "/root/alpha");
    assert.include(paths, "/root/beta");
  });

  it("emits child traffic BEFORE the item that registers the child", () => {
    // Ordering hazard: the child's own thread/status/changed arrives before
    // the parent-side subAgentActivity naming it. Registration must tolerate
    // child-first arrival, so unregistered child traffic passes through
    // rather than being eaten (no regression vs. pre-feature behavior).
    const firstChildTraffic = notifications.findIndex((entry) => {
      const threadId = notificationThreadId(entry);
      return threadId !== undefined && childThreadIds.has(threadId);
    });
    const firstRegistration = notifications.findIndex((entry) => {
      const item = entry.params.item;
      if (typeof item !== "object" || item === null) return false;
      const record = item as Record<string, unknown>;
      return record.type === "subAgentActivity" && record.kind === "started";
    });
    assert.isAtLeast(firstChildTraffic, 0);
    assert.isAtLeast(firstRegistration, 0);
    assert.isBelow(
      firstChildTraffic,
      firstRegistration,
      "capture should exercise child-first ordering",
    );
  });

  it("contains a /root self-activity emitted from a CHILD thread", () => {
    // The bug this guards: the wire reports subAgentActivity about the ROOT
    // (agentPath "/root"). Registering it made the runtime intercept the
    // parent's own final message and turn/completed, so the thread hung
    // "working" forever. The root guard must key on agentPath/thread id,
    // never on which thread the notification arrived from.
    const rootSelfActivity = subAgentActivityItems().find((item) => item.agentPath === "/root");
    assert.isDefined(rootSelfActivity, "capture should contain a /root self-activity");
    assert.equal(rootSelfActivity?.agentThreadId, rootThreadId);
  });

  it("routes every captured child method to a defined disposition", () => {
    const childMethods = new Set(
      notifications
        .filter((entry) => {
          const threadId = notificationThreadId(entry);
          return threadId !== undefined && childThreadIds.has(threadId);
        })
        .map((entry) => entry.method),
    );
    assert.isAbove(childMethods.size, 0);
    for (const method of childMethods) {
      const route = routeCodexChildNotification(method);
      // Child lifecycle traffic must become agent events — never silently
      // dropped, never leaked to the parent timeline.
      assert.equal(route, "agent-event", `${method} should map to an agent event`);
    }
  });
});

describe("routeCodexChildNotification", () => {
  it("maps child lifecycle to agent events", () => {
    for (const method of [
      "turn/started",
      "turn/completed",
      "thread/status/changed",
      "thread/tokenUsage/updated",
      "item/started",
      "item/completed",
      "thread/closed",
      "error",
    ]) {
      assert.equal(routeCodexChildNotification(method), "agent-event", method);
    }
  });

  it("drops only enumerated child chatter", () => {
    for (const method of [
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "turn/plan/updated",
      "thread/name/updated",
    ]) {
      assert.equal(routeCodexChildNotification(method), "drop", method);
    }
  });

  it("never routes child-owned thread lifecycle to the parent", () => {
    // These mutate PARENT thread state in CodexAdapter (archived/compacted),
    // so a child emitting them must never reach the parent path. This list
    // mirrors shouldSuppressChildConversationNotification (the v1 collab
    // suppressor) — the two must not drift (review finding: the router
    // initially omitted them and they leaked).
    for (const method of [
      "thread/started",
      "thread/status/changed",
      "thread/archived",
      "thread/unarchived",
      "thread/closed",
      "thread/compacted",
      "thread/name/updated",
      "thread/tokenUsage/updated",
      "turn/started",
      "turn/completed",
      "turn/plan/updated",
      "item/plan/delta",
    ]) {
      assert.notEqual(
        routeCodexChildNotification(method),
        "parent",
        `${method} is child-owned and must not reach the parent path`,
      );
    }
  });

  it("sends parent-owned and UNKNOWN methods to the parent path", () => {
    // serverRequest/resolved clears the parent's approval correlation:
    // swallowing it left approvals stuck (shipped bug). Unknown methods take
    // the same route by design — a codex update that adds a notification
    // must degrade to "parent sees it", never to silent loss.
    assert.equal(routeCodexChildNotification("serverRequest/resolved"), "parent");
    assert.equal(routeCodexChildNotification("thread/somethingBrandNew"), "parent");
    assert.equal(routeCodexChildNotification("account/rateLimits/updated"), "parent");
  });
});
