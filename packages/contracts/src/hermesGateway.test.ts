import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HERMES_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  HERMES_DRIVER_KIND,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import {
  HERMES_GATEWAY_PROTOCOL_VERSION,
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
      pluginVersion: "0.2.0",
      hermesVersion: "1.2.3",
      model: "gpt-5.6-terra",
      connectionGeneration: 3,
      activeSessionCount: 2,
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      capabilities: {
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: true,
      },
    });
    expect(connected.status).toBe("connected");
    expect(connected.activeSessionCount).toBe(2);
    expect(connected.model).toBe("gpt-5.6-terra");

    // A plugin that predates the `model` field still produces a valid status;
    // the picker falls back to the generic label rather than failing to decode.
    const withoutModel = decodeInstanceStatus({ ...connected, model: null });
    expect(withoutModel.model).toBeNull();

    const upgradeRequired = decodeInstanceStatus({
      ...connected,
      status: "upgrade-required",
      protocolVersion: 3,
      capabilities: null,
    });
    expect(upgradeRequired.protocolVersion).toBe(3);
    expect(upgradeRequired.capabilities).toBeNull();
  });
});

describe("Hermes gateway handshake", () => {
  it("uses protocol v5 for model and reasoning selection", () => {
    expect(HERMES_GATEWAY_PROTOCOL_VERSION).toBe(5);
  });

  it("accepts one-time enrollment authentication", () => {
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-1",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      pluginVersion: "0.2.0",
      hermesVersion: "1.2.3",
      capabilities: {
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
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

    expect(hello.authentication.type).toBe("enrollment-token");
  });

  it("accepts persistent instance authentication", () => {
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-2",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      pluginVersion: "0.2.0",
      hermesVersion: "1.2.3",
      capabilities: {
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: true,
      },
      model: "gpt-5.6-terra",
      authentication: {
        type: "instance-credential",
        instanceId: "hermes-research",
        credential: "persistent-secret",
      },
    });

    expect(hello.authentication.type).toBe("instance-credential");
    expect(hello.model).toBe("gpt-5.6-terra");
  });

  // The plugin ships separately from the server, so a plugin that predates the
  // `model` field must still complete the handshake rather than failing the
  // frame decoder. T3 falls back to the generic model label.
  it("accepts a hello from a plugin that reports no model", () => {
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-no-model",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      pluginVersion: "0.2.0",
      hermesVersion: "1.2.3",
      capabilities: {
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: true,
      },
      authentication: {
        type: "instance-credential",
        instanceId: "hermes-research",
        credential: "persistent-secret",
      },
    });

    expect(hello.model).toBeUndefined();
  });

  it("decodes an other-version hello so the broker can reject it explicitly", () => {
    // A v3 plugin (pre-media) must reach the broker's structured
    // `version-incompatible` rejection rather than dying in the frame decoder.
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-other-version",
      protocolVersion: 3,
      pluginVersion: "0.3.0",
      hermesVersion: "2.0.0",
      capabilities: {
        protocolVersion: 3,
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

    expect(hello.protocolVersion).toBe(3);
    expect(hello.capabilities.protocolVersion).toBe(3);
  });

  it("requires attachments as part of the current contract", () => {
    // Not a negotiated option: a v5 plugin that cannot handle attachments is
    // a pre-v4 plugin, and belongs at the version gate instead.
    expect(() =>
      decodeCapabilities({
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: false,
      }),
    ).toThrow();
  });
});

describe("T3 to Hermes messages", () => {
  it("decodes session creation and opaque resume cursors", () => {
    expect(
      decodeT3Message({
        type: "session.ensure",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: "ensure-1",
        threadId: "thread-1",
        resumeSessionId: "opaque/hermes/session/value",
      }).type,
    ).toBe("session.ensure");

    expect(
      decodeResumeCursor({
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        sessionId: "opaque/hermes/session/value",
      }).sessionId,
    ).toBe("opaque/hermes/session/value");
  });

  it("decodes model and reasoning selection only on a turn start", () => {
    const context = {
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: "turn-command-1",
      threadId: "thread-1",
      sessionId: "session-1",
      turnId: "turn-1",
      text: "Keep the current turn running, but use this guidance.",
    };

    const start = decodeT3Message({
      type: "turn.start",
      ...context,
      modelSelection: {
        mode: "specific",
        provider: "  openrouter  ",
        model: "  anthropic/claude-sonnet-4  ",
      },
      reasoningEffort: "high",
    });
    expect(start.type).toBe("turn.start");
    if (start.type !== "turn.start") {
      throw new Error("expected turn.start");
    }
    expect(start.modelSelection).toEqual({
      mode: "specific",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(start.reasoningEffort).toBe("high");

    const steer = decodeT3Message({ type: "turn.steer", ...context });
    expect(steer.type).toBe("turn.steer");
    if (steer.type !== "turn.steer") {
      throw new Error("expected turn.steer");
    }
    expect("modelSelection" in steer).toBe(false);
    expect("reasoningEffort" in steer).toBe(false);
  });

  it("decodes the default model request and rejects invalid selections", () => {
    const context = {
      type: "turn.start",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: "turn-command-2",
      threadId: "thread-1",
      sessionId: "session-1",
      turnId: "turn-2",
      text: "Use the configured default.",
    } as const;

    const start = decodeT3Message({
      ...context,
      modelSelection: { mode: "default" },
      reasoningEffort: "none",
    });
    expect(start.type).toBe("turn.start");

    expect(() =>
      decodeT3Message({
        ...context,
        modelSelection: { mode: "specific", provider: " ", model: "gpt-5" },
      }),
    ).toThrow();
    expect(() => decodeT3Message({ ...context, reasoningEffort: "extreme" })).toThrow();
  });

  it("decodes model catalog requests", () => {
    expect(
      decodeT3Message({
        type: "models.list.request",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: "models-1",
      }).type,
    ).toBe("models.list.request");
  });

  it("decodes interrupt, approval, structured input, stop, and ping", () => {
    const turnContext = {
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
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
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: "stop-1",
        threadId: "thread-1",
        sessionId: "session-1",
      }).type,
    ).toBe("session.stop");
    expect(
      decodeT3Message({
        type: "ping",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: "ping-1",
        sentAt: "2026-07-23T12:00:00.000Z",
      }).type,
    ).toBe("ping");
  });

  it("rejects post-handshake frames from another protocol version", () => {
    expect(() =>
      decodeT3Message({
        type: "ping",
        // Protocol v1 peers must upgrade before sending post-handshake frames.
        protocolVersion: 1,
        requestId: "ping-1",
        sentAt: "2026-07-23T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("defaults an unstated connection role to gateway", () => {
    // The field is about intent, not tolerance: a hello that says nothing is
    // the ordinary live plugin, which must never be read as a throwaway
    // delivery socket.
    const hello = decodeHello({
      type: "connection.hello",
      requestId: "hello-role-default",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      pluginVersion: "0.2.0",
      hermesVersion: "1.2.3",
      capabilities: {
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        streaming: true,
        activity: true,
        approvals: true,
        userInput: true,
        attachments: true,
      },
      authentication: { type: "instance-credential", instanceId: "hermes", credential: "secret" },
    });

    expect(hello.role).toBe("gateway");
  });

  it("carries the home thread designation on acceptance", () => {
    const accepted = decodeT3Message({
      type: "connection.accepted",
      requestId: "hello-1",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      instanceId: "hermes",
      nickname: "Remote Hermes",
      homeThreadId: "thread-home-1",
    });

    expect(accepted.type).toBe("connection.accepted");
    if (accepted.type === "connection.accepted") {
      expect(accepted.homeThreadId).toBe("thread-home-1");
    }

    // Optional: a handshake whose home-thread resolution failed still accepts
    // the plugin rather than refusing an authenticated connection.
    const withoutHome = decodeT3Message({
      type: "connection.accepted",
      requestId: "hello-2",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      instanceId: "hermes",
      nickname: "Remote Hermes",
    });
    expect(withoutHome.type).toBe("connection.accepted");
  });
});

describe("Hermes home deliveries", () => {
  const delivery = {
    type: "home.deliver",
    protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
    deliveryId: "delivery-1",
    threadId: "thread-home-1",
    kind: "cron",
    label: "Cron: daily-digest",
    text: "Your digest is ready.",
    createdAt: "2026-07-25T12:00:00.000Z",
  } as const;

  it("decodes a delivery and its acknowledgement", () => {
    const decoded = decodePluginMessage(delivery);
    expect(decoded.type).toBe("home.deliver");
    if (decoded.type === "home.deliver") {
      expect(decoded.kind).toBe("cron");
      expect(decoded.deliveryId).toBe("delivery-1");
    }

    const ack = decodeT3Message({
      type: "home.deliver.ack",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      deliveryId: "delivery-1",
    });
    expect(ack.type).toBe("home.deliver.ack");
  });

  it("requires a delivery id, since it is the dedupe key for retries", () => {
    expect(() => decodePluginMessage({ ...delivery, deliveryId: "" })).toThrow();
  });

  it("rejects an unknown delivery kind rather than guessing a badge", () => {
    expect(() => decodePluginMessage({ ...delivery, kind: "surprise" })).toThrow();
  });

  it("rejects empty delivery text", () => {
    expect(() => decodePluginMessage({ ...delivery, text: "" })).toThrow();
  });
});

describe("Hermes media deliveries", () => {
  const media = {
    type: "media.deliver",
    protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
    deliveryId: "media-1",
    threadId: "thread-home-1",
    kind: "cron",
    label: "Cron: daily-digest",
    name: "digest-chart.png",
    mimeType: "image/png",
    sizeBytes: 4,
    data: "AAAA",
    createdAt: "2026-07-27T12:00:00.000Z",
  } as const;

  it("decodes turnless media, turn-scoped media, and the acknowledgement", () => {
    const proactive = decodePluginMessage(media);
    expect(proactive.type).toBe("media.deliver");
    if (proactive.type === "media.deliver") {
      expect(proactive.turnId).toBeUndefined();
      expect(proactive.kind).toBe("cron");
    }

    const turnScoped = decodePluginMessage({ ...media, turnId: "turn-1", caption: "Today's run" });
    if (turnScoped.type === "media.deliver") {
      expect(turnScoped.turnId).toBe("turn-1");
      expect(turnScoped.caption).toBe("Today's run");
    }

    const ack = decodeT3Message({
      type: "media.deliver.ack",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      deliveryId: "media-1",
    });
    expect(ack.type).toBe("media.deliver.ack");
  });

  it("requires a delivery id, since it is the dedupe key for retries", () => {
    expect(() => decodePluginMessage({ ...media, deliveryId: "" })).toThrow();
  });

  it("rejects empty payloads and zero-byte sizes", () => {
    expect(() => decodePluginMessage({ ...media, data: "" })).toThrow();
    expect(() => decodePluginMessage({ ...media, sizeBytes: 0 })).toThrow();
  });

  it("bounds the base64 payload at the frame ceiling", () => {
    // One character past the ceiling for a 25MB file must fail at decode,
    // before anything buffers or writes.
    const overCeiling = "A".repeat(Math.ceil((25 * 1024 * 1024) / 3) * 4 + 8);
    expect(() => decodePluginMessage({ ...media, data: overCeiling })).toThrow();
  });
});

describe("Hermes to T3 events", () => {
  const turnContext = {
    protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
    threadId: "thread-1",
    sessionId: "session-1",
    turnId: "turn-1",
  };

  it("decodes session readiness, turn start, streaming text, and completion", () => {
    const legacyReady = decodePluginMessage({
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: "ensure-1",
      threadId: "thread-1",
      sessionId: "session-1",
      resumed: false,
    });
    expect(legacyReady.type).toBe("session.ready");
    const activeReady = decodePluginMessage({
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: "ensure-2",
      threadId: "thread-1",
      sessionId: "session-1",
      resumed: true,
      activeTurnId: "turn-1",
    });
    expect(activeReady.type).toBe("session.ready");
    if (activeReady.type !== "session.ready") {
      throw new Error("expected session.ready");
    }
    expect(activeReady.activeTurnId).toBe("turn-1");
    const started = decodePluginMessage({
      type: "turn.started",
      requestId: "turn-command-1",
      appliedModelSelection: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
      },
      appliedReasoningEffort: "high",
      ...turnContext,
    });
    expect(started.type).toBe("turn.started");
    if (started.type !== "turn.started") {
      throw new Error("expected turn.started");
    }
    expect(started.appliedModelSelection).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(started.appliedReasoningEffort).toBe("high");
    expect(
      decodePluginMessage({
        type: "content.delta",
        streamKind: "assistant_text",
        delta: "Hello",
        ...turnContext,
      }).type,
    ).toBe("content.delta");
    const snapshot = decodePluginMessage({
      type: "content.snapshot",
      streamKind: "assistant_text",
      text: "",
      itemId: "message-1",
      contentIndex: 0,
      ...turnContext,
    });
    expect(snapshot.type).toBe("content.snapshot");
    if (snapshot.type !== "content.snapshot") {
      throw new Error("expected content.snapshot");
    }
    expect(snapshot.text).toBe("");
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

  it("decodes the selectable model catalog and reasoning efforts", () => {
    const catalog = decodePluginMessage({
      type: "models.list.response",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: "models-1",
      currentProvider: "  openrouter  ",
      currentModel: "  anthropic/claude-sonnet-4  ",
      currentReasoningEffort: "high",
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      models: [
        {
          provider: "  openrouter  ",
          providerName: "  OpenRouter  ",
          model: "  anthropic/claude-sonnet-4  ",
          supportsReasoning: true,
        },
        {
          provider: "anthropic",
          providerName: "Anthropic",
          model: "claude-haiku-4-5",
          supportsReasoning: false,
        },
      ],
    });

    expect(catalog.type).toBe("models.list.response");
    if (catalog.type !== "models.list.response") {
      throw new Error("expected models.list.response");
    }
    expect(catalog.currentProvider).toBe("openrouter");
    expect(catalog.currentModel).toBe("anthropic/claude-sonnet-4");
    expect(catalog.reasoningEfforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(catalog.models[0]).toEqual({
      provider: "openrouter",
      providerName: "OpenRouter",
      model: "anthropic/claude-sonnet-4",
      supportsReasoning: true,
    });
  });
});

describe("Hermes provider integration constants", () => {
  it("keeps Hermes's stable fallback model slug", () => {
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
