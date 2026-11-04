import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { OrchestrationV2RpcSchemas, OrchestrationV2TurnItemJson } from "./orchestrationV2.ts";
import { PluginManifest } from "./plugin.ts";
import { PluginApprovalAnswer } from "./pluginApprovals.ts";
import { PluginInstallationManifest } from "./pluginCatalog.ts";

const approvalItem = {
  id: "item-1",
  threadId: "thread-1",
  runId: null,
  nodeId: "node-1",
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: "2026-10-04T00:00:00.000Z",
  completedAt: "2026-10-04T00:00:01.000Z",
  updatedAt: "2026-10-04T00:00:01.000Z",
  type: "approval_request",
  requestId: "request-1",
  requestKind: "command",
  prompt: "git status",
};
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeManifest = Schema.decodeUnknownExit(PluginManifest);
const decodeCatalogManifest = Schema.decodeUnknownSync(PluginInstallationManifest);
const decodeAnswer = Schema.decodeUnknownExit(PluginApprovalAnswer);
const resolvedByOf = (raw: unknown) => {
  const item = decodeItem(raw);
  return item.type === "approval_request" ? item.resolvedBy : "not an approval";
};

describe("approval resolvedBy", () => {
  it("decodes a plugin answer and keeps the item when the resolver is unknown", () => {
    const resolvedBy = {
      _tag: "plugin",
      pluginId: "acme.policy",
      pluginName: "Policy",
      decision: "decline",
      reason: "Deletes files.",
    };
    expect(resolvedByOf({ ...approvalItem, resolvedBy })).toEqual(resolvedBy);
    // An older server sends none; a newer server's resolver reads as absent.
    expect(resolvedByOf(approvalItem)).toBeUndefined();
    expect(resolvedByOf({ ...approvalItem, resolvedBy: { _tag: "rule", rule: "x" } })).toBe(
      undefined,
    );
    expect(
      resolvedByOf({ ...approvalItem, resolvedBy: { ...resolvedBy, decision: "acceptAlways" } }),
    ).toBeUndefined();
  });
});

describe("plugin answers on the wire", () => {
  it("cannot be sent by a client", () => {
    const decodeClientCommand = Schema.decodeUnknownExit(
      OrchestrationV2RpcSchemas.dispatchCommand.input,
    );
    const pluginAnswer = {
      type: "runtime-request.plugin-respond",
      commandId: "plugin-approval:request-1:installation-1:1",
      threadId: "thread-1",
      requestId: "request-1",
      resolvedBy: {
        _tag: "plugin",
        pluginId: "acme.policy",
        pluginName: "Policy",
        decision: "accept",
      },
    };
    expect(Exit.isFailure(decodeClientCommand(pluginAnswer))).toBe(true);
  });
});

describe("PluginApprovalAnswer", () => {
  it("accepts approve, deny, abstain and null, and nothing else", () => {
    for (const valid of [
      null,
      { decision: "abstain" },
      { decision: "approve", reason: "Read-only." },
      { decision: "deny" },
    ])
      expect(Exit.isSuccess(decodeAnswer(valid))).toBe(true);
    for (const invalid of [
      undefined,
      "approve",
      { decision: "allow" },
      { decision: "approve", reason: "x".repeat(501) },
    ])
      expect(Exit.isFailure(decodeAnswer(invalid))).toBe(true);
  });
});

describe("approvals declaration", () => {
  const manifest = {
    id: "acme.policy",
    name: "Policy",
    version: "1.0.0",
    apiVersion: 1,
    entry: "main.mjs",
    capabilities: ["approvals"],
    proposedApi: true,
  };
  it("accepts the kinds plugins may answer and refuses others in the manifest", () => {
    const accepted = decodeManifest({
      ...manifest,
      approvals: { kinds: ["command", "file-change"] },
    });
    expect(Exit.isSuccess(accepted) && accepted.value.approvals).toEqual({
      kinds: ["command", "file-change"],
    });
    for (const approvals of [
      { kinds: [] },
      { kinds: ["mcp-elicitation"] },
      { kinds: ["command"], timeoutSeconds: 121 },
    ])
      expect(Exit.isFailure(decodeManifest({ ...manifest, approvals }))).toBe(true);
  });

  it("keeps a catalogue row whose declaration a newer server allows", () => {
    const decoded = decodeCatalogManifest({
      ...manifest,
      approvals: { kinds: ["command", "network"] },
    });
    expect(decoded.id).toBe("acme.policy");
    expect(decoded.approvals).toBeUndefined();
  });
});
