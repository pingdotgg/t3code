import { RunId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { pendingUserShellItems } from "./userShellCommands.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const doneRun = RunId.make("run-done");
const activeRun = RunId.make("run-active");

const command = (
  id: string,
  runId: RunId | null,
  userShell?: { readonly delivery: "pending" | "delivered" | "dismissed" },
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId: v2ThreadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: userShell ? "You ran" : null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "command_execution",
  input: id,
  ...(userShell ? { userShell: { cwd: "/repo", ...userShell } } : {}),
});

describe("pendingUserShellItems", () => {
  it("keeps pending user-run commands whose run is no longer active", () => {
    const pending = pendingUserShellItems({
      runs: [
        { id: doneRun, status: "completed" },
        { id: activeRun, status: "running" },
      ],
      turnItems: [
        command("settled", doneRun, { delivery: "pending" }),
        command("runless", null, { delivery: "pending" }),
        command("in-flight", activeRun, { delivery: "pending" }),
        command("delivered", doneRun, { delivery: "delivered" }),
        command("dismissed", doneRun, { delivery: "dismissed" }),
        command("agent", doneRun),
      ],
    });
    expect(pending.map((item) => item.input)).toEqual(["settled", "runless"]);
  });
});
