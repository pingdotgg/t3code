import { expect, it } from "@effect/vitest";
import {
  COMMAND_CODE_DEFAULT_INSTANCE_ID,
  COMMAND_CODE_PROVIDER,
  COMMAND_CODE_SUPPORTED_RUNTIME_MODES,
  commandCodeAcpSpawnArgs,
  commandCodeApprovalOptions,
  resolveCommandCodeAcpBaseModelId,
  resolveCommandCodeAuthMethodId,
} from "@t3tools/provider-command-code/testing";
import type * as EffectAcpSchema from "effect-acp/compat";

it("CommandCodeAdapterV2 config and options", () => {
  expect(COMMAND_CODE_PROVIDER).toBe("commandCode");
  expect(COMMAND_CODE_DEFAULT_INSTANCE_ID).toBe("commandCode");
  expect(commandCodeAcpSpawnArgs()).toEqual(["acp"]);
  expect(resolveCommandCodeAuthMethodId()).toBe("command-code-cli");
  expect(COMMAND_CODE_SUPPORTED_RUNTIME_MODES).toContain("approval-required");
  expect(COMMAND_CODE_SUPPORTED_RUNTIME_MODES).toContain("auto-accept-edits");
  expect(COMMAND_CODE_SUPPORTED_RUNTIME_MODES).toContain("auto");
  expect(COMMAND_CODE_SUPPORTED_RUNTIME_MODES).toContain("full-access");
  expect(resolveCommandCodeAcpBaseModelId(undefined)).toBe("gpt-5.6-sol");
  expect(resolveCommandCodeAcpBaseModelId("claude-opus-4-6")).toBe("claude-opus-4-6");

  const permissionRequest: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "session-1",
    options: [
      { optionId: "opt-1", name: "Approve once", kind: "allow_once" },
      { optionId: "opt-2", name: "Allow all session", kind: "allow_always" },
      { optionId: "opt-3", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "call-1",
      title: "Write file",
      kind: "edit",
    },
  };

  const options = commandCodeApprovalOptions(permissionRequest);
  expect(options.some((opt) => opt.decision === "cancel")).toBe(true);
  expect(options.some((opt) => opt.decision === "accept")).toBe(true);
  expect(options.some((opt) => opt.decision === "decline")).toBe(true);
  expect(options.some((opt) => opt.decision === "acceptForSession")).toBe(true);
});
