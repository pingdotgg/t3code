import { describe, expect, it } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  selectCopilotPermissionForDecision,
  selectCopilotPermissionForRuntimeMode,
} from "./CopilotAcpPermissions.ts";
import type { AcpPermissionRequest } from "./AcpRuntimeModel.ts";

const OPTIONS = [
  { optionId: "allow-once-id", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always-id", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once-id", name: "Reject", kind: "reject_once" },
] satisfies ReadonlyArray<EffectAcpSchema.PermissionOption>;

function request(
  input: Partial<EffectAcpSchema.RequestPermissionRequest["toolCall"]> = {},
  options: ReadonlyArray<EffectAcpSchema.PermissionOption> = OPTIONS,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: {
      toolCallId: "tool-1",
      kind: "execute",
      status: "pending",
      title: "Run command",
      rawInput: { command: "bun test" },
      ...input,
    },
  };
}

function permission(input: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest {
  return {
    kind: "execute",
    detail: "bun test",
    toolCall: {
      toolCallId: "tool-1",
      kind: "execute",
      itemType: "command_execution",
      status: "pending",
      data: { toolCallId: "tool-1" },
    },
    ...input,
  };
}

describe("CopilotAcpPermissions", () => {
  it("auto-selects allow options in full-access for known requests", () => {
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "full-access",
        params: request(),
        permissionRequest: permission(),
      }),
    ).toEqual({ _tag: "select", optionId: "allow-always-id" });
  });

  it("requires approval for unknown or question-like requests even in full-access", () => {
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "full-access",
        params: request({ kind: "other", title: "Ask user a question?" }),
        permissionRequest: permission({
          kind: "other",
          toolCall: {
            toolCallId: "tool-1",
            kind: "other",
            itemType: "dynamic_tool_call",
            data: { toolCallId: "tool-1" },
          },
        }),
      }),
    ).toEqual({ _tag: "ask" });
  });

  it("auto-approves edit/file-change requests only in auto-accept-edits", () => {
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "auto-accept-edits",
        params: request({ kind: "edit", title: "Edit file" }),
        permissionRequest: permission({
          kind: "edit",
          toolCall: {
            toolCallId: "tool-1",
            kind: "edit",
            itemType: "file_change",
            data: { toolCallId: "tool-1" },
          },
        }),
      }),
    ).toEqual({ _tag: "select", optionId: "allow-once-id" });

    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "auto-accept-edits",
        params: request(),
        permissionRequest: permission(),
      }),
    ).toEqual({ _tag: "ask" });
  });

  it("requires approval in approval-required mode", () => {
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "approval-required",
        params: request(),
        permissionRequest: permission(),
      }),
    ).toEqual({ _tag: "ask" });
  });

  it("maps explicit user decisions to advertised ACP option IDs", () => {
    expect(
      selectCopilotPermissionForDecision({
        params: request(),
        decision: "accept",
      }),
    ).toEqual({ _tag: "select", optionId: "allow-once-id" });

    expect(
      selectCopilotPermissionForDecision({
        params: request(),
        decision: "acceptForSession",
      }),
    ).toEqual({ _tag: "select", optionId: "allow-always-id" });

    expect(
      selectCopilotPermissionForDecision({
        params: request(),
        decision: "decline",
      }),
    ).toEqual({ _tag: "select", optionId: "reject-once-id" });
  });

  it("falls back safely when explicit decisions cannot be represented", () => {
    expect(
      selectCopilotPermissionForDecision({
        params: request({}, [
          { optionId: "allow-once-id", name: "Allow once", kind: "allow_once" },
        ]),
        decision: "decline",
      }),
    ).toEqual({ _tag: "cancel" });

    expect(
      selectCopilotPermissionForDecision({
        params: request({}, [{ optionId: "reject-once-id", name: "Reject", kind: "reject_once" }]),
        decision: "accept",
      }),
    ).toEqual({ _tag: "cancel" });

    expect(
      selectCopilotPermissionForDecision({
        params: request(),
        decision: "cancel",
      }),
    ).toEqual({ _tag: "cancel" });
  });
});
