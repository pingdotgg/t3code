import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { commandFeatureUsage, featureUsage } from "./FeatureUsage.ts";

const command = Schema.decodeUnknownSync(OrchestrationV2Command);
const ids = { commandId: "command-private", threadId: "thread-private" };

it("ignores messages, housekeeping commands, and untracked RPCs", () => {
  expect(
    commandFeatureUsage(
      command({
        ...ids,
        type: "message.dispatch",
        messageId: "message-private",
        text: "secret prompt",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      }),
    ),
  ).toBe(undefined);
  expect(
    commandFeatureUsage(
      command({ ...ids, type: "thread.visit", visitedAt: "2026-10-24T00:00:00.000Z" }),
    ),
  ).toBe(undefined);
  expect(featureUsage(WS_METHODS.terminalWrite, { data: "rm -rf" })).toBe(undefined);
});

it("leaves thread launches to client.thread.started", () => {
  expect(
    featureUsage(ORCHESTRATION_V2_WS_METHODS.launchThread, {
      title: "Private title",
      workspaceStrategy: { type: "worktree", baseRef: "main", branch: "secret-branch" },
    }),
  ).toBe(undefined);
});

it("tells watching a pull request apart from unwatching it", () => {
  const watch = (watching: boolean) =>
    commandFeatureUsage(
      command({
        ...ids,
        type: "thread.pull-request.watch",
        host: "github.com",
        repository: "owner/private",
        number: 7,
        watching,
      }),
    );
  expect(watch(true)).toEqual({ feature: "thread.pull_request.watch", variant: "on" });
  expect(watch(false)).toEqual({ feature: "thread.pull_request.watch", variant: "off" });
});

it("reads RPC variants from enums, never from paths or text", () => {
  expect(
    featureUsage(WS_METHODS.shellOpenInEditor, { cwd: "/Users/someone/secret", editor: "cursor" }),
  ).toEqual({ feature: "editor.open", variant: "cursor" });
  expect(featureUsage(WS_METHODS.terminalOpen, { cwd: "/Users/someone/secret" })).toEqual({
    feature: "terminal.open",
  });
});

it("counts the owner's guest share actions, and only guest message sends", () => {
  const send = (guestMessageId?: string) =>
    commandFeatureUsage(
      command({
        ...ids,
        type: "message.dispatch",
        messageId: "message-private",
        text: "secret prompt",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
        ...(guestMessageId === undefined ? {} : { guestMessageId }),
      }),
    );
  expect(send("guest-message-private")).toEqual({ feature: "guest_message.send" });
  expect(send()).toBe(undefined);
  expect(
    commandFeatureUsage(
      command({ ...ids, type: "thread.guest-message.dismiss", guestMessageId: "guest-private" }),
    ),
  ).toEqual({ feature: "guest_message.dismiss" });
  expect(commandFeatureUsage(command({ ...ids, type: "thread.guest-share.close" }))).toEqual({
    feature: "guest_share.close",
  });
  expect(featureUsage(WS_METHODS.guestShareCreate, { threadId: "thread-private" })).toEqual({
    feature: "guest_share.create",
  });
});
