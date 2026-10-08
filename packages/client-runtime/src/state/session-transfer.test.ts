import { expect, it, vi } from "vite-plus/test";
import { ThreadId, type SessionTransferImportResult } from "@t3tools/contracts";
import { runSessionTransfer } from "./session-transfer.ts";
const local: SessionTransferImportResult = {
  threadId: ThreadId.make("local"),
  workspaceRoot: "/local",
  contextPrompt: "context",
  runtimeMode: "approval-required",
  interactionMode: "default",
};
it("never stops the source if importing the local workspace fails", async () => {
  const stopRemote = vi.fn();
  const startLocal = vi.fn();
  await expect(
    runSessionTransfer({
      capture: async () => "archive",
      prepareLocal: async () => {
        throw new Error("disk full");
      },
      stopRemote,
      startLocal,
    }),
  ).rejects.toThrow("disk full");
  expect(stopRemote).not.toHaveBeenCalled();
  expect(startLocal).not.toHaveBeenCalled();
});
it("does not start a second agent if the remote stop fails, and retains the prepared thread", async () => {
  const startLocal = vi.fn();
  const result = await runSessionTransfer({
    capture: async () => "archive",
    prepareLocal: async () => local,
    stopRemote: async () => {
      throw new Error("source changed");
    },
    startLocal,
  });
  expect(result).toMatchObject({ status: "remote-stop-failed", local });
  expect(startLocal).not.toHaveBeenCalled();
});
it("retains the local thread if its agent cannot start after stopping the source", async () => {
  const result = await runSessionTransfer({
    capture: async () => "archive",
    prepareLocal: async () => local,
    stopRemote: async () => {},
    startLocal: async () => {
      throw new Error("provider unavailable");
    },
  });
  expect(result).toMatchObject({ status: "local-start-failed", local });
});
it("starts local work only after preparing its workspace and stopping the source", async () => {
  const events: string[] = [];
  const result = await runSessionTransfer({
    capture: async () => {
      events.push("capture");
      return "archive";
    },
    prepareLocal: async () => {
      events.push("prepare");
      return local;
    },
    stopRemote: async () => {
      events.push("stop");
    },
    startLocal: async () => {
      events.push("start");
    },
  });
  expect(events).toEqual(["capture", "prepare", "stop", "start"]);
  expect(result.status).toBe("complete");
});
