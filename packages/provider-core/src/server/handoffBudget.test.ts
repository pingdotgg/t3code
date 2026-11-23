import { assert, it } from "@effect/vitest";
import {
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { historicalMessage } from "./handoffBudget.ts";

it("leaves user command output out of the history a provider is given", () => {
  const now = DateTime.makeUnsafe("2026-11-01T12:00:00.000Z");
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item-1"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread-1"),
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "/hello",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_command",
    command: "hello",
    args: "",
    format: "markdown",
    markdown: "# hi",
  };
  assert.equal(historicalMessage(item), null);
});
