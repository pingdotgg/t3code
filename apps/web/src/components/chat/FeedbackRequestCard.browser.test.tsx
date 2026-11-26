import type { FeedbackRequestItem } from "@t3tools/client-runtime/feedback-request";
import {
  AgentFeedbackRequestError,
  EnvironmentId,
  NodeId,
  RunId,
  ServerConfig,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

const environmentId = EnvironmentId.make("feedback-env");
const decodeServerConfig = Schema.decodeSync(ServerConfig);

function makeServerConfig(telemetryEnabled?: boolean): ServerConfig {
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
      ...(telemetryEnabled === undefined ? {} : { telemetryEnabled }),
    },
    settings: {},
  });
}

const state = vi.hoisted(() => ({
  answer: vi.fn(),
  canAnswer: true,
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
      permissionAtom: () => Atom.make(state.canAnswer),
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

function resetState(telemetryEnabled?: boolean) {
  state.answer.mockReset();
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  state.canAnswer = true;
  state.configs = new Map([[environmentId, makeServerConfig(telemetryEnabled)]]);
}

describe("FeedbackRequestCard", () => {
  it("explains that telemetry is off, disables Send, and still allows Don't send", async () => {
    resetState(false);
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

  it("keeps Send enabled when telemetry is on or omitted by an older server", async () => {
    for (const telemetryEnabled of [true, undefined]) {
      resetState(telemetryEnabled);
      await using screen = await render(
        <FeedbackRequestCard environmentId={environmentId} item={pendingItem} visibility="local" />,
        { router: false },
      );

      await expect.element(screen.getByText("Send this report to the T3 team?")).toBeVisible();
      const sendButton = screen.getByRole("button", { name: "Send", exact: true });
      await expect.element(sendButton).toBeEnabled();
      await expect.element(screen.getByRole("switch")).toBeEnabled();
      await sendButton.click();
      expect(state.answer).toHaveBeenCalledWith({
        environmentId,
        input: {
          threadId: pendingItem.threadId,
          turnItemId: pendingItem.id,
          answer: "send",
          includeConversation: false,
        },
      });
    }
  });

  it("shows the server telemetry_off error if telemetry turns off before Send", async () => {
    resetState(true);
    state.answer.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new AgentFeedbackRequestError({ reason: "telemetry_off" }))),
    );
    await using screen = await render(
      <FeedbackRequestCard environmentId={environmentId} item={pendingItem} visibility="local" />,
      { router: false },
    );

    await screen.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Telemetry is off on this machine, so this report was not sent.");
  });
});
