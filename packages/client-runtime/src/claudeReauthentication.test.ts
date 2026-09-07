import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getClaudeReauthenticationTarget } from "./claudeReauthentication.ts";
import { v2Now, v2Projection } from "./state/orchestrationV2TestFixtures.ts";

const instanceId = ProviderInstanceId.make("claude-work");
const provider = { instanceId, driver: ProviderDriverKind.make("claudeAgent"), enabled: true };
const providers = [provider];
const run: OrchestrationV2Run = {
  id: RunId.make("failed-run"),
  threadId: v2Projection.thread.id,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "sonnet" },
  providerThreadId: null,
  userMessageId: MessageId.make("failed-message"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "failed",
  requestedAt: v2Now,
  startedAt: v2Now,
  completedAt: v2Now,
  checkpointId: null,
  contextHandoffId: null,
};
const errorItem: OrchestrationV2TurnItem = {
  id: TurnItemId.make("auth-error"),
  threadId: run.threadId,
  runId: run.id,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "failed",
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
  type: "error",
  failure: { class: "auth_error", message: "Claude is signed out.", code: null, retryable: false },
};
const projection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, providerInstanceId: instanceId },
  runs: [run],
  turnItems: [errorItem],
};

describe("getClaudeReauthenticationTarget", () => {
  it("uses the failed run's instance and identity for both clients", () => {
    expect(getClaudeReauthenticationTarget(projection, providers)).toEqual({
      threadId: run.threadId,
      instanceId,
      runId: run.id,
      message: "Claude is signed out.",
    });
  });

  it.each(["queued", "running", "completed", "failed"] as const)(
    "does not recover an old auth failure after a newer %s run",
    (status) => {
      const newer = { ...run, id: RunId.make("newer-run"), ordinal: 2, status };
      expect(
        getClaudeReauthenticationTarget({ ...projection, runs: [newer, run] }, providers),
      ).toBeNull();
    },
  );

  it("ignores authentication failures from a subagent", () => {
    expect(
      getClaudeReauthenticationTarget(
        {
          ...projection,
          turnItems: [{ ...errorItem, nodeId: NodeId.make("child-node") }],
        },
        providers,
      ),
    ).toBeNull();
  });

  it("does not retry while an older run is still active", () => {
    expect(
      getClaudeReauthenticationTarget(
        {
          ...projection,
          runs: [{ ...run, id: RunId.make("active-run"), ordinal: 0, status: "running" }, run],
        },
        providers,
      ),
    ).toBeNull();
  });

  it("does not offer login for another provider or a disabled instance", () => {
    expect(
      getClaudeReauthenticationTarget(projection, [
        { ...provider, driver: ProviderDriverKind.make("codex") },
      ]),
    ).toBeNull();
    expect(
      getClaudeReauthenticationTarget(projection, [{ ...provider, enabled: false }]),
    ).toBeNull();
    expect(getClaudeReauthenticationTarget(projection, [])).toBeNull();
  });

  it("does not offer login after changing providers or archiving the thread", () => {
    for (const thread of [
      { ...projection.thread, providerInstanceId: ProviderInstanceId.make("other-claude") },
      { ...projection.thread, archivedAt: v2Now },
      { ...projection.thread, deletedAt: v2Now },
    ]) {
      expect(getClaudeReauthenticationTarget({ ...projection, thread }, providers)).toBeNull();
    }
  });

  it("does not replace a later non-authentication failure with an earlier auth error", () => {
    const laterError: OrchestrationV2TurnItem = {
      ...errorItem,
      id: TurnItemId.make("transport-error"),
      ordinal: 2,
      failure: { class: "transport_error", message: "Disconnected", code: null, retryable: true },
    };
    for (const turnItems of [
      [errorItem, laterError],
      [laterError, errorItem],
    ]) {
      expect(getClaudeReauthenticationTarget({ ...projection, turnItems }, providers)).toBeNull();
    }
    expect(
      getClaudeReauthenticationTarget(
        {
          ...projection,
          turnItems: [{ ...errorItem, ordinal: 3 }, laterError],
        },
        providers,
      )?.runId,
    ).toBe(run.id);
  });
});
