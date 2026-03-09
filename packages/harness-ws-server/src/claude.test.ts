import { describe, expect, it } from "vitest";
import { EventId, HarnessSessionId } from "@t3tools/contracts";
import { createClaudeAgentSdkAdapter } from "./claude";

describe("createClaudeAgentSdkAdapter", () => {
  it("wraps SDK-native events into harness-scoped events", async () => {
    const adapter = createClaudeAgentSdkAdapter({
      sdk: {
        async createSession() {
          return { sessionId: "claude-session" };
        },
        async resumeSession() {},
        async sendTurn() {
          return {};
        },
        async cancelTurn() {},
        async resolvePermission() {},
        async resolveElicitation() {},
        async updateSessionConfig() {},
        async shutdownSession() {},
        async *streamEvents() {
          yield {
            eventId: EventId.makeUnsafe("evt-1"),
            sessionId: HarnessSessionId.makeUnsafe("claude-session"),
            createdAt: "2026-03-09T00:00:00.000Z",
            sequence: 1,
            type: "message.delta",
            payload: { role: "assistant", stream: "assistant", delta: "hello" },
          };
        },
      },
    });

    const session = await adapter.createSession({
      profile: {
        id: "profile-1" as never,
        name: "Claude",
        harness: "claude-agent-sdk",
        adapterFamily: "sdk",
        connectionMode: "spawned",
        enabled: true,
        config: { claudeAgentSdk: {} },
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
      },
    });

    const events: string[] = [];
    for await (const event of adapter.streamEvents!({ session })) {
      events.push(event.harness);
    }

    expect(events).toEqual(["claude-agent-sdk"]);
  });
});
