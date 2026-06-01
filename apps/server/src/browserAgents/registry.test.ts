import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ThreadId,
  type BrowserAgentOutboundMessage,
} from "@t3tools/contracts";

import { BrowserAgentRegistry } from "./registry.ts";

const capabilities = {
  version: 1 as const,
  canCaptureVisibleTab: true,
  canInjectScripts: true,
  canFocusTabs: true,
  canGroupTabs: true,
  canAnnotate: true,
  canRenderInlineSidebar: true,
};

const device = {
  extensionVersion: "0.0.1",
  userAgent: "test-browser-agent",
};

const workspaceInput = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  devServerUrl: "http://100.105.249.96:3000/",
  repoName: "repo",
};

function connectAgent(
  registry: BrowserAgentRegistry,
  sessionId: AuthSessionId,
): BrowserAgentOutboundMessage[] {
  const sentMessages: BrowserAgentOutboundMessage[] = [];
  const connectionId = registry.connect({
    sessionId,
    send: (message) =>
      Effect.sync(() => {
        sentMessages.push(message);
      }),
  });
  registry.handleMessage(connectionId, {
    type: "browserAgent.hello",
    device,
    capabilities,
  });
  return sentMessages;
}

describe("BrowserAgentRegistry", () => {
  it("sends preview commands to the browser agent for the requesting session", async () => {
    const registry = new BrowserAgentRegistry();
    const hostSessionId = AuthSessionId.make("session-host");
    const remoteSessionId = AuthSessionId.make("session-remote");
    const hostMessages = connectAgent(registry, hostSessionId);

    await Effect.runPromise(
      registry.openOrFocusPreview(workspaceInput, {
        preferredSessionId: hostSessionId,
      }),
    );
    expect(hostMessages).toHaveLength(1);

    const remoteMessages = connectAgent(registry, remoteSessionId);
    const result = await Effect.runPromise(
      registry.openOrFocusPreview(workspaceInput, {
        preferredSessionId: remoteSessionId,
      }),
    );

    expect(result.agentId).toBe("browser-agent:session-remote");
    expect(remoteMessages).toHaveLength(1);
    expect(remoteMessages[0]?.type).toBe("browserAgent.command.openOrFocusPreview");
    expect(hostMessages).toHaveLength(1);
  });

  it("does not reuse a host workspace link when the requesting session has no agent", async () => {
    const registry = new BrowserAgentRegistry();
    const hostSessionId = AuthSessionId.make("session-host");
    const remoteSessionId = AuthSessionId.make("session-remote");
    const hostMessages = connectAgent(registry, hostSessionId);

    await Effect.runPromise(
      registry.openOrFocusPreview(workspaceInput, {
        preferredSessionId: hostSessionId,
      }),
    );

    await expect(
      Effect.runPromise(
        registry.openOrFocusPreview(workspaceInput, {
          preferredSessionId: remoteSessionId,
        }),
      ),
    ).rejects.toMatchObject({
      code: "no-agent-connected",
    });
    expect(hostMessages).toHaveLength(1);
  });
});
