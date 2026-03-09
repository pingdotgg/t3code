import { describe, expect, it } from "vitest";
import { HarnessProfileId } from "@t3tools/contracts";
import type { HarnessAdapter } from "./adapters";
import { HarnessService } from "./server";

function createTestAdapter(): HarnessAdapter {
  return {
    key: "claude-agent-sdk",
    harness: "claude-agent-sdk",
    family: "sdk",
    defaultConnectionMode: "spawned",
    capabilities: {
      resume: true,
      cancel: true,
      modelSwitch: "restart-required",
      permissions: true,
      elicitation: true,
      toolLifecycle: true,
      reasoningStream: true,
      planStream: true,
      fileArtifacts: true,
      checkpoints: false,
      subagents: true,
    },
    validateProfile() {},
    async createSession(input) {
      return {
        id: "claude-session" as never,
        profileId: input.profile.id,
        harness: "claude-agent-sdk",
        adapterKey: "claude-agent-sdk",
        connectionMode: "spawned",
        title: input.title ?? null,
        cwd: null,
        model: null,
        mode: null,
        state: "starting",
        activeTurnId: null,
        nativeSessionId: "native-claude-session",
        lastError: null,
        capabilities: this.capabilities,
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
      };
    },
    async resumeSession(input) {
      return input.session;
    },
    async sendTurn() {},
    async cancelTurn() {},
    async resolvePermission() {},
    async resolveElicitation() {},
    async updateSessionConfig() {},
    async shutdownSession() {},
  };
}

describe("HarnessService", () => {
  it("creates sessions and projects canonical lifecycle events into the snapshot", async () => {
    const service = new HarnessService({
      adapters: [createTestAdapter()],
      now: () => "2026-03-09T00:00:00.000Z",
    });

    const profileId = HarnessProfileId.makeUnsafe("profile-claude");
    service.upsertProfile({
      id: profileId,
      name: "Claude",
      harness: "claude-agent-sdk",
      adapterFamily: "sdk",
      connectionMode: "spawned",
      enabled: true,
      config: {
        claudeAgentSdk: {},
      },
      createdAt: "2026-03-09T00:00:00.000Z",
      updatedAt: "2026-03-09T00:00:00.000Z",
    });

    const session = await service.createSession(profileId, "My Claude Session");
    const snapshot = service.getSnapshot();

    expect(session.nativeSessionId).toBe("native-claude-session");
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.bindings).toHaveLength(1);
    expect(snapshot.sessions[0]?.title).toBe("My Claude Session");
  });
});
