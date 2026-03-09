import { describe, expect, it } from "vitest";
import { EventId, HarnessSessionId, RuntimeRequestId } from "@t3tools/contracts";
import { createEmptyHarnessSnapshot, projectHarnessEvent } from "./projector";

describe("projectHarnessEvent", () => {
  it("tracks session lifecycle and pending interaction projections", () => {
    const sessionId = HarnessSessionId.makeUnsafe("session-1");
    let snapshot = createEmptyHarnessSnapshot("2026-03-09T00:00:00.000Z");

    snapshot = projectHarnessEvent(snapshot, {
      eventId: EventId.makeUnsafe("evt-session"),
      sessionId,
      createdAt: "2026-03-09T00:00:00.000Z",
      sequence: 1,
      harness: "opencode",
      adapterKey: "opencode-direct",
      connectionMode: "spawned",
      type: "session.created",
      payload: {
        title: "OpenCode Session",
        state: "starting",
        capabilities: {
          resume: true,
          cancel: true,
          modelSwitch: "restart-required",
          permissions: true,
          elicitation: true,
          toolLifecycle: true,
          reasoningStream: false,
          planStream: true,
          fileArtifacts: true,
          checkpoints: false,
          subagents: true,
        },
      },
    });

    snapshot = projectHarnessEvent(snapshot, {
      eventId: EventId.makeUnsafe("evt-permission"),
      sessionId,
      createdAt: "2026-03-09T00:00:01.000Z",
      sequence: 2,
      harness: "opencode",
      adapterKey: "opencode-direct",
      connectionMode: "spawned",
      type: "permission.requested",
      payload: {
        requestId: RuntimeRequestId.makeUnsafe("perm-1"),
        kind: "command",
        title: "Run command",
      },
    });

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.pendingPermissions).toHaveLength(1);
  });
});
