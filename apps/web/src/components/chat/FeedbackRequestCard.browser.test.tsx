import type { FeedbackRequestItem } from "@t3tools/client-runtime/feedback-request";
import {
  EnvironmentId,
  NodeId,
  RunId,
  ServerConfig,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

const environmentId = EnvironmentId.make("feedback-env");
const decodeServerConfig = Schema.decodeSync(ServerConfig);

function makeServerConfig(telemetryEnabled: boolean): ServerConfig {
  return decodeServerConfig({
    environment: {
      environmentId,
      label: "Desk",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.0.0",
      orchestrationProtocolVersion: 2,
      capabilities: { agentFeedback: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "t3_session",
    },
    cwd: "/workspace/demo",
    keybindingsConfigPath: "/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      telemetryEnabled,
    },
    settings: {},
  });
}

const state = vi.hoisted(() => ({
  answer: vi.fn(),
  configs: new Map<EnvironmentId, ServerConfig>(),
}));

vi.mock("../../state/entities", () => ({
  useServerConfigs: () => state.configs,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.answer,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    answerFeedbackRequest: {
      permissionAtom: () => Atom.make(true),
    },
  },
}));

import { FeedbackRequestCard } from "./FeedbackRequestCard";

const pendingItem: FeedbackRequestItem = {
  id: TurnItemId.make("turn-item:feedback-request:report-1"),
  threadId: ThreadId.make("thread:feedback-1"),
  runId: RunId.make("run:1"),
  nodeId: NodeId.make("node:1"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  type: "feedback_request",
  status: "waiting",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-11-26T00:00:00.000Z"),
  feedbackStatus: "pending",
  preview: {
    kind: "bug",
    subject: "t3_thread_read",
    expected: "Return the latest messages.",
    actual: "Returned an empty list.",
    workaround: "Read by run id instead.",
    trace: {
      turns: 2,
      textTurns: 0,
      truncated: false,
      entries: [
        { turn: 1, type: "user", length: 24 },
        { turn: 1, type: "tool", tool: "t3_thread_read", outcome: "error", durationMs: 320 },
      ],
    },
  },
  conversationTrace: {
    turns: 2,
    textTurns: 1,
    truncated: false,
    entries: [
      { turn: 1, type: "user", length: 24, text: "Check the thread messages." },
      { turn: 1, type: "tool", tool: "t3_thread_read", outcome: "error", durationMs: 320 },
    ],
  },
};

describe("FeedbackRequestCard", () => {
  it("explains that telemetry is off, disables Send, and still allows Don't send", async () => {
    state.answer.mockResolvedValue(AsyncResult.success(undefined));
    state.configs = new Map([[environmentId, makeServerConfig(false)]]);
    await using screen = await render(
      <FeedbackRequestCard environmentId={environmentId} item={pendingItem} visibility="local" />,
      { router: false },
    );

    await expect.element(screen.getByText("Feedback report cannot be sent")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Telemetry is off on this machine, so this report cannot be sent to the T3 team.",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect.element(screen.getByRole("switch")).toBeDisabled();
    const decline = screen.getByRole("button", { name: "Don't send", exact: true });
    await expect.element(decline).toBeEnabled();

    await decline.click();
    expect(state.answer).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: pendingItem.threadId,
        turnItemId: pendingItem.id,
        answer: "decline",
        includeConversation: false,
      },
    });
  });
});
