import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  resolveHermesRuntimeMode,
  selectHermesAutoApprovedPermissionOption,
  selectHermesPermissionOptionId,
} from "./HermesAdapter.ts";

const permissionRequest = {
  sessionId: "hermes-session",
  toolCall: { toolCallId: "tool-1", title: "Run command" },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("Hermes adapter policy mapping", () => {
  it("maps T3 runtime modes to Hermes ACP modes", () => {
    expect(resolveHermesRuntimeMode("approval-required")).toBe("default");
    expect(resolveHermesRuntimeMode("auto")).toBe("default");
    expect(resolveHermesRuntimeMode("auto-accept-edits")).toBe("accept_edits");
    expect(resolveHermesRuntimeMode("full-access")).toBe("dont_ask");
  });

  it("uses exact Hermes option ids and avoids permanent auto-approval", () => {
    expect(selectHermesPermissionOptionId(permissionRequest, "accept")).toBe("allow_once");
    expect(selectHermesPermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "allow_session",
    );
    expect(selectHermesPermissionOptionId(permissionRequest, "decline")).toBe("deny");
    expect(selectHermesAutoApprovedPermissionOption(permissionRequest)).toBe("allow_session");
  });

  it("falls back to ACP option kinds and only auto-approves once", () => {
    const genericRequest = {
      ...permissionRequest,
      options: [
        { optionId: "temporary", kind: "allow_once", name: "Temporarily allow" },
        { optionId: "permanent", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    } satisfies EffectAcpSchema.RequestPermissionRequest;

    expect(selectHermesPermissionOptionId(genericRequest, "accept")).toBe("temporary");
    expect(selectHermesPermissionOptionId(genericRequest, "decline")).toBe("reject");
    expect(selectHermesAutoApprovedPermissionOption(genericRequest)).toBe("temporary");
  });
});
