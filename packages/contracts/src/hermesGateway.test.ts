import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HERMES_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  HERMES_DRIVER_KIND,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import {
  HermesGatewayCapabilities,
  HermesGatewayConnectionHello,
  HermesGatewayCreateEnrollmentInput,
  HermesGatewayInstanceStatus,
  HermesGatewayPluginToT3Message,
  HermesGatewayResumeCursor,
  HermesGatewayT3ToPluginMessage,
} from "./hermesGateway.ts";
import { WS_METHODS } from "./rpc.ts";
import { DEFAULT_SERVER_SETTINGS, HermesSettings } from "./settings.ts";

const decodeCreateEnrollment = Schema.decodeUnknownSync(HermesGatewayCreateEnrollmentInput);
const decodeCapabilities = Schema.decodeUnknownSync(HermesGatewayCapabilities);
const decodeInstanceStatus = Schema.decodeUnknownSync(HermesGatewayInstanceStatus);
const decodeHello = Schema.decodeUnknownSync(HermesGatewayConnectionHello);
const decodeResumeCursor = Schema.decodeUnknownSync(HermesGatewayResumeCursor);
const decodeT3Message = Schema.decodeUnknownSync(HermesGatewayT3ToPluginMessage);
const decodePluginMessage = Schema.decodeUnknownSync(HermesGatewayPluginToT3Message);
const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);

describe("Hermes gateway management contracts", () => {
  it("decodes an enrollment request without deriving identity from the nickname", () => {
    expect(
      decodeCreateEnrollment({
        instanceId: "hermes-research",
        nickname: "  Research  ",
        connectorUrl: "  https://siva.davis7.space:3774/hermes  ",
      }),
    ).toEqual({
      instanceId: "hermes-research",
      nickname: "Research",
      connectorUrl: "https://siva.davis7.space:3774/hermes",
    });
  });

  it("rejects invalid provider ids and non-connector URL schemes", () => {
    expect(() =>
      decodeCreateEnrollment({
        instanceId: "1-hermes",
        nickname: "Research",
        connectorUrl: "wss://siva.davis7.space/hermes",
      }),
    ).toThrow();
    expect(() =>
      decodeCreateEnrollment({
        instanceId: "hermes-research",
        nickname: "Research",
        connectorUrl: "ftp://siva.davis7.space/hermes",
      }),
    ).toThrow();
  });

  it("represents connected and upgrade-required instances for the web UI", () => {
    const connected = decodeInstanceStatus({
      instanceId: "hermes-research",
      nickname: "Research",
      status: "connected",
      connectorUrl: "wss://siva.davis7.space/hermes",
      lastConnectedAt: "2026-07-23T12:00:00.000Z",
      pluginVersion: "0.1.0",
      hermesVersion: "1.2.3",
      activeSessionCount: 2,
      protocolVersion: 1,
      capabilities: {
        protocolVersion: 1,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: false,
      },
    });
    expect(connected.status).toBe("connected");
    expect(connected.activeSessionCount).toBe(2);

    const upgradeRequired = decodeInstanceStatus({
      ...connected,
      status: "upgrade-required",
      protocolVersion: 2,
      capabilities: null,
    });
    expect(upgradeRequired.protocolVersion).toBe(2);
    expect(upgradeRequired.capabilities).toBeNull();
  });
});

describe("Hermes gateway handshake", () => {
  it("accepts one-time enrollment authentication", () => {
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-1",
      protocolVersion: 1,
      pluginVersion: "0.1.0",
      hermesVersion: "1.2.3",
      capabilities: {
        protocolVersion: 1,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: false,
      },
      authentication: {
        type: "enrollment-token",
        token: "enroll-secret",
      },
    });

    expect(hello.authentication.type).toBe("enrollment-token");
  });

  it("accepts persistent instance authentication", () => {
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-2",
      protocolVersion: 1,
      pluginVersion: "0.1.0",
      hermesVersion: "1.2.3",
      capabilities: {
        protocolVersion: 1,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: false,
      },
      authentication: {
        type: "instance-credential",
        instanceId: "hermes-research",
        credential: "persistent-secret",
      },
    });

    expect(hello.authentication.type).toBe("instance-credential");
  });

  it("decodes a future-version hello so the broker can reject it explicitly", () => {
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-future",
      protocolVersion: 2,
      pluginVersion: "0.2.0",
      hermesVersion: "2.0.0",
      capabilities: {
        protocolVersion: 2,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: true,
      },
      authentication: {
        type: "enrollment-token",
        token: "enroll-secret",
      },
    });

    expect(hello.protocolVersion).toBe(2);
    expect(hello.capabilities.protocolVersion).toBe(2);
  });

  it("reserves attachments for a future protocol version", () => {
    expect(() =>
      decodeCapabilities({
        protocolVersion: 1,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: true,
      }),
    ).toThrow();
  });
});

describe("T3 to Hermes v1 messages", () => {
  it("decodes session creation and opaque resume cursors", () => {
    expect(
      decodeT3Message({
        type: "session.ensure",
        protocolVersion: 1,
        requestId: "ensure-1",
        threadId: "thread-1",
        resumeSessionId: "opaque/hermes/session/value",
      }).type,
    ).toBe("session.ensure");

    expect(
      decodeResumeCursor({
        protocolVersion: 1,
        sessionId: "opaque/hermes/session/value",
      }).sessionId,
    ).toBe("opaque/hermes/session/value");
  });

  it("decodes start and steering as distinct turn operations", () => {
    const context = {
      protocolVersion: 1,
      requestId: "turn-command-1",
      threadId: "thread-1",
      sessionId: "session-1",
      turnId: "turn-1",
      text: "Keep the current turn running, but use this guidance.",
    };

    expect(decodeT3Message({ type: "turn.start", ...context }).type).toBe("turn.start");
    expect(decodeT3Message({ type: "turn.steer", ...context }).type).toBe("turn.steer");
  });

  it("decodes interrupt, approval, structured input, stop, and ping", () => {
    const turnContext = {
      protocolVersion: 1,
      threadId: "thread-1",
      sessionId: "session-1",
      turnId: "turn-1",
    };

    expect(
      decodeT3Message({
        type: "turn.interrupt",
        requestId: "interrupt-1",
        ...turnContext,
      }).type,
    ).toBe("turn.interrupt");
    expect(
      decodeT3Message({
        type: "approval.respond",
        requestId: "approval-1",
        decision: "acceptForSession",
        ...turnContext,
      }).type,
    ).toBe("approval.respond");
    expect(
      decodeT3Message({
        type: "user-input.respond",
        requestId: "question-1",
        answers: { environment: "production" },
        ...turnContext,
      }).type,
    ).toBe("user-input.respond");
    expect(
      decodeT3Message({
        type: "session.stop",
        protocolVersion: 1,
        requestId: "stop-1",
        threadId: "thread-1",
        sessionId: "session-1",
      }).type,
    ).toBe("session.stop");
    expect(
      decodeT3Message({
        type: "ping",
        protocolVersion: 1,
        requestId: "ping-1",
        sentAt: "2026-07-23T12:00:00.000Z",
      }).type,
    ).toBe("ping");
  });

  it("rejects post-handshake frames from another protocol version", () => {
    expect(() =>
      decodeT3Message({
        type: "ping",
        protocolVersion: 2,
        requestId: "ping-1",
        sentAt: "2026-07-23T12:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("Hermes to T3 v1 events", () => {
  const turnContext = {
    protocolVersion: 1,
    threadId: "thread-1",
    sessionId: "session-1",
    turnId: "turn-1",
  };

  it("decodes session readiness, turn start, streaming text, and completion", () => {
    expect(
      decodePluginMessage({
        type: "session.ready",
        protocolVersion: 1,
        requestId: "ensure-1",
        threadId: "thread-1",
        sessionId: "session-1",
        resumed: false,
      }).type,
    ).toBe("session.ready");
    expect(
      decodePluginMessage({
        type: "turn.started",
        requestId: "turn-command-1",
        ...turnContext,
      }).type,
    ).toBe("turn.started");
    expect(
      decodePluginMessage({
        type: "content.delta",
        streamKind: "assistant_text",
        delta: "Hello",
        ...turnContext,
      }).type,
    ).toBe("content.delta");
    expect(
      decodePluginMessage({
        type: "turn.completed",
        state: "completed",
        ...turnContext,
      }).type,
    ).toBe("turn.completed");
  });

  it("decodes activity lifecycle events with normalized and generic data", () => {
    for (const type of ["item.started", "item.updated", "item.completed"] as const) {
      expect(
        decodePluginMessage({
          type,
          itemId: "tool-1",
          itemType: "mcp_tool_call",
          status: type === "item.completed" ? "completed" : "inProgress",
          title: "Search",
          detail: "Looking up the requested information",
          data: { providerKind: "hermes-native-event" },
          ...turnContext,
        }).type,
      ).toBe(type);
    }
  });

  it("decodes approvals and structured user-input lifecycle events", () => {
    expect(
      decodePluginMessage({
        type: "request.opened",
        requestId: "approval-1",
        requestType: "command_execution_approval",
        detail: "Run the command?",
        args: { command: "git status" },
        ...turnContext,
      }).type,
    ).toBe("request.opened");
    expect(
      decodePluginMessage({
        type: "request.resolved",
        requestId: "approval-1",
        requestType: "command_execution_approval",
        decision: "accept",
        ...turnContext,
      }).type,
    ).toBe("request.resolved");
    expect(
      decodePluginMessage({
        type: "user-input.requested",
        requestId: "question-1",
        questions: [
          {
            id: "environment",
            header: "Target",
            question: "Which environment?",
            options: [
              {
                label: "Staging",
                description: "Deploy to the staging environment.",
              },
            ],
          },
        ],
        ...turnContext,
      }).type,
    ).toBe("user-input.requested");
    expect(
      decodePluginMessage({
        type: "user-input.resolved",
        requestId: "question-1",
        answers: { environment: "Staging" },
        ...turnContext,
      }).type,
    ).toBe("user-input.resolved");
  });
});

describe("Hermes provider integration constants", () => {
  it("exposes Hermes as a single opaque model in the normal provider picker", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[HERMES_DRIVER_KIND]).toBe(DEFAULT_HERMES_MODEL);
    expect(PROVIDER_DISPLAY_NAMES[HERMES_DRIVER_KIND]).toBe("Hermes");
  });

  it("keeps Hermes server settings remote-only", () => {
    expect(decodeHermesSettings({})).toEqual({
      enabled: true,
    });
    expect(DEFAULT_SERVER_SETTINGS.providers.hermes).toEqual({
      enabled: true,
    });
  });

  it("registers the web-management RPC method names", () => {
    expect(WS_METHODS.hermesGatewayCreateEnrollment).toBe("hermesGateway.createEnrollment");
    expect(WS_METHODS.hermesGatewayGetInstanceStatus).toBe("hermesGateway.getInstanceStatus");
    expect(WS_METHODS.hermesGatewayListInstances).toBe("hermesGateway.listInstances");
    expect(WS_METHODS.hermesGatewayRevokeInstance).toBe("hermesGateway.revokeInstance");
  });
});
