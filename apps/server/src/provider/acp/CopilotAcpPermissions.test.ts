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

function mcpToolPermission(): AcpPermissionRequest {
  return permission({
    kind: "other",
    detail: "create_isolated_workspace",
    toolCall: {
      toolCallId: "tool-1",
      kind: "other",
      itemType: "mcp_tool_call",
      status: "pending",
      data: { toolCallId: "tool-1" },
    },
  });
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

  it("rejects raw Git worktree add/move so agents must use workspace handoff tools", () => {
    for (const command of [
      "git worktree add /tmp/feature -b feature",
      "git -C /repo worktree move /tmp/old /tmp/new",
    ]) {
      expect(
        selectCopilotPermissionForRuntimeMode({
          runtimeMode: "full-access",
          params: request({ rawInput: { command } }),
          permissionRequest: permission({ detail: command }),
        }),
      ).toEqual({ _tag: "cancel", reason: "workspace_handoff_required" });
    }
  });

  it("allows git worktree remove in full-access mode", () => {
    const command = "cd /repo && git worktree remove /tmp/feature";
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "full-access",
        params: request({ rawInput: { command } }),
        permissionRequest: permission({ detail: command }),
      }),
    ).toEqual({ _tag: "select", optionId: "allow-always-id" });
  });

  it("continues auto-approving read-only Git worktree commands", () => {
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "full-access",
        params: request({ rawInput: { command: "git worktree list" } }),
        permissionRequest: permission({ detail: "git worktree list" }),
      }),
    ).toEqual({ _tag: "select", optionId: "allow-always-id" });
  });

  it("does not mistake shell status expansion for a user question in full-access", () => {
    const command =
      't3 chat list --base-dir "$HOME/.t3" >/tmp/t3-cli-out 2>/tmp/t3-cli-err; code=$?; printf "code=%s\\n" "$code"';

    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "full-access",
        params: request({ rawInput: { command } }),
        permissionRequest: permission({ detail: command }),
      }),
    ).toEqual({ _tag: "select", optionId: "allow-always-id" });
  });

  it("auto-approves MCP tool calls in full-access instead of silently cancelling them", () => {
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "full-access",
        params: request({
          kind: "other",
          title: "create_isolated_workspace",
          rawInput: { path: "/tmp/wt", branch: "feat/x", baseRef: "main" },
        }),
        permissionRequest: mcpToolPermission(),
      }),
    ).toEqual({ _tag: "select", optionId: "allow-always-id" });
  });

  it("asks for approval on MCP tool calls in non-full-access modes", () => {
    for (const runtimeMode of ["auto-accept-edits", "approval-required"] as const) {
      expect(
        selectCopilotPermissionForRuntimeMode({
          runtimeMode,
          params: request({
            kind: "other",
            title: "create_isolated_workspace",
            rawInput: { path: "/tmp/wt", branch: "feat/x", baseRef: "main" },
          }),
          permissionRequest: mcpToolPermission(),
        }),
      ).toEqual({ _tag: "ask" });
    }
  });

  it("requires approval for question-like known requests", () => {
    expect(
      selectCopilotPermissionForRuntimeMode({
        runtimeMode: "full-access",
        params: request({ title: "Ask user a question?" }),
        permissionRequest: permission(),
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
