import {
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { commandItemOutput } from "./commandOutput.ts";

const envelope =
  '{"stdout":"line 1\\n行 2 🚀","stderr":"é warning","interrupted":false,"requestId":"keep-me"}\n';

const commandItem = (driver: string, startedAt: string) =>
  ({
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: {
      driver: ProviderDriverKind.make(driver),
      nativeId: "tool-1",
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: DateTime.makeUnsafe(startedAt),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(startedAt),
    type: "command_execution",
    input: "node print-json.js",
    output: envelope,
  }) satisfies OrchestrationV2TurnItem;

describe("commandItemOutput", () => {
  it("unwraps an early Claude row's raw Bash result into stdout and stderr", () => {
    expect(commandItemOutput(commandItem("claudeAgent", "2026-10-03T12:00:00Z"))).toBe(
      "line 1\n行 2 🚀\né warning",
    );
  });

  it.each([
    ["codex", "2026-10-03T12:00:00Z"],
    ["claudeAgent", "2026-11-01T12:00:00Z"],
  ])("keeps literal JSON a %s command printed at %s", (driver, startedAt) => {
    expect(commandItemOutput(commandItem(driver, startedAt))).toBe(envelope);
  });
});
