import { CommandId, ORCHESTRATION_V2_WS_METHODS, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { featureUsage } from "./FeatureUsage.ts";

const dispatch = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
const threadId = ThreadId.make("thread-private");
const commandId = CommandId.make("command-private");

it("names user commands with their closed-enum variant and nothing else", () => {
  expect(
    featureUsage(dispatch, {
      type: "checkpoint.rollback",
      commandId,
      threadId,
      scopeId: "scope-private",
      checkpointId: "checkpoint-private",
      restoreFiles: false,
    }),
  ).toEqual({ feature: "checkpoint.rollback", variant: "conversation_only" });
  expect(
    featureUsage(dispatch, {
      type: "thread.runtime-mode.set",
      commandId,
      threadId,
      runtimeMode: "full-access",
    }),
  ).toEqual({ feature: "thread.runtime_mode.set", variant: "full-access" });
});

it("ignores messages, housekeeping commands, and untracked RPCs", () => {
  expect(featureUsage(dispatch, { type: "message.dispatch", text: "secret prompt" })).toBe(
    undefined,
  );
  expect(featureUsage(dispatch, { type: "thread.visit", threadId })).toBe(undefined);
  expect(featureUsage(WS_METHODS.terminalWrite, { data: "rm -rf" })).toBe(undefined);
});

it("reads RPC variants from enums, never from paths or text", () => {
  expect(
    featureUsage(WS_METHODS.shellOpenInEditor, { cwd: "/Users/someone/secret", editor: "cursor" }),
  ).toEqual({ feature: "editor.open", variant: "cursor" });
  expect(
    featureUsage(ORCHESTRATION_V2_WS_METHODS.launchThread, {
      title: "Private title",
      workspaceStrategy: { type: "worktree", baseRef: "main", branch: "secret-branch" },
    }),
  ).toEqual({ feature: "thread.launch", variant: "worktree" });
  expect(featureUsage(WS_METHODS.terminalOpen, { cwd: "/Users/someone/secret" })).toEqual({
    feature: "terminal.open",
  });
});
