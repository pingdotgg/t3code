import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";

import {
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  openCodePermissionRequestKind,
  openCodeToolProjectionKind,
  makeOpenCodeProtocolLogger,
  OPENCODE_PROVIDER,
  OpenCodeProviderCapabilitiesV2,
} from "./OpenCodeAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function runtimePolicy(
  runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapterV2RuntimePolicy {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}

function permissionAction(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)
    ?.action;
}

function providerTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(input.id),
    providerThreadId: ProviderThreadId.make("provider-thread:opencode-test"),
    nodeId: NodeId.make(`node:${input.id}`),
    runAttemptId: null,
    nativeTurnRef:
      input.nativeId === null
        ? null
        : { driver: OPENCODE_PROVIDER, nativeId: input.nativeId, strength: "weak" },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
}

describe("OpenCodeAdapterV2", () => {
  it.effect("logs bounded structural protocol diagnostics without native payload values", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const records: Array<unknown> = [];
      const nativeEventLogger: EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) => Effect.sync(() => void records.push(event)),
        close: () => Effect.void,
      };
      const logProtocolEvent = makeOpenCodeProtocolLogger({
        nativeEventLogger,
        idAllocator,
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        providerSessionId: ProviderSessionId.make("provider-session-opencode-test"),
        threadId: ThreadId.make("thread-opencode-test"),
      });
      const secret = "secret-opencode-prompt";

      yield* logProtocolEvent({
        direction: "outgoing",
        messageKind: "request",
        method: "session.prompt",
        payload: { prompt: secret, nested: { token: secret } },
      });

      const serialized = encodeUnknownJson(records);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"protocol":"opencode-sdk.sse"');
      assert.include(serialized, '"method":"session.prompt"');
      assert.include(serialized, '"fieldCount":2');
    }).pipe(Effect.provide(idAllocatorLayer)),
  );

  it("advertises the identity strengths exposed by the SDK boundary", () => {
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeThreadIds, "strong");
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeTurnIds, "weak");
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeItemIds, "strong");
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeRequestIds, "strong");
    assert.isTrue(OpenCodeProviderCapabilitiesV2.threads.canForkFromTurn);
    assert.isTrue(OpenCodeProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.equal(OpenCodeProviderCapabilitiesV2.turns.terminalStatusQuality, "strong");
    assert.isFalse(OpenCodeProviderCapabilitiesV2.subagents.canCloseSubagents);
  });

  it("maps native permission families to orchestration request kinds", () => {
    assert.equal(openCodePermissionRequestKind("bash"), "command");
    assert.equal(openCodePermissionRequestKind("read"), "file-read");
    assert.equal(openCodePermissionRequestKind("grep"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory", "edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("apply_patch"), "file-change");
  });

  it("maps OpenCode tools to semantic turn-item families", () => {
    assert.equal(openCodeToolProjectionKind("bash"), "command_execution");
    assert.equal(openCodeToolProjectionKind("edit"), "file_change");
    assert.equal(openCodeToolProjectionKind("read"), "file_search");
    assert.equal(openCodeToolProjectionKind("lsp"), "file_search");
    assert.equal(openCodeToolProjectionKind("websearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("codesearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("custom_tool"), "dynamic_tool");
  });

  it("maps runtime modes to safe OpenCode permission rules", () => {
    const approvalRequired = openCodePermissionRules(runtimePolicy("approval-required"));
    assert.equal(permissionAction(approvalRequired, "read"), "allow");
    assert.equal(permissionAction(approvalRequired, "edit"), "ask");
    assert.equal(permissionAction(approvalRequired, "bash"), "ask");
    assert.equal(permissionAction(approvalRequired, "doom_loop"), "ask");
    assert.equal(permissionAction(approvalRequired, "unknown_plugin_tool"), "ask");
    assert.equal(permissionAction(approvalRequired, "question"), "allow");

    const autoAcceptEdits = openCodePermissionRules(runtimePolicy("auto-accept-edits"));
    assert.equal(permissionAction(autoAcceptEdits, "edit"), "allow");
    assert.equal(permissionAction(autoAcceptEdits, "bash"), "ask");

    const fullAccess = openCodePermissionRules(runtimePolicy("full-access"));
    assert.equal(permissionAction(fullAccess, "bash"), "allow");
    assert.equal(permissionAction(fullAccess, "edit"), "allow");

    const granularApproval = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: { granular: { request_permissions: true } },
      }),
    );
    assert.equal(permissionAction(granularApproval, "bash"), "ask");
    assert.equal(permissionAction(granularApproval, "read"), "allow");
  });

  it("enforces non-interactive sandbox policy through OpenCode permissions", () => {
    const readOnly = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(readOnly, "read"), "allow");
    assert.equal(permissionAction(readOnly, "edit"), "deny");
    assert.equal(permissionAction(readOnly, "bash"), "deny");
    assert.equal(permissionAction(readOnly, "webfetch"), "deny");
    assert.equal(permissionAction(readOnly, "doom_loop"), "deny");
    assert.equal(permissionAction(readOnly, "unknown_plugin_tool"), "deny");
    assert.equal(permissionAction(readOnly, "external_directory"), "allow");

    const workspaceWrite = openCodePermissionRules(
      runtimePolicy("auto-accept-edits", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: true,
        },
      }),
    );
    assert.equal(permissionAction(workspaceWrite, "edit"), "allow");
    assert.equal(permissionAction(workspaceWrite, "bash"), "deny");
    assert.equal(permissionAction(workspaceWrite, "webfetch"), "allow");
    assert.deepInclude(workspaceWrite, {
      permission: "external_directory",
      pattern: "/tmp/opencode-workspace/*",
      action: "allow",
    });
  });

  it("preserves OpenCode's recursion guard on task-created child sessions", () => {
    const childRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);

    assert.equal(permissionAction(childRules, "read"), "allow");
    assert.equal(permissionAction(childRules, "bash"), "allow");
    assert.equal(permissionAction(childRules, "task"), "deny");

    const approvalRequiredPolicy = runtimePolicy("approval-required");
    const parentRules = openCodePermissionRules(approvalRequiredPolicy);
    const childApprovalRules = openCodeChildPermissionRules(approvalRequiredPolicy, [
      ...parentRules.filter((rule) => rule.action === "deny"),
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    assert.equal(permissionAction(childApprovalRules, "bash"), "ask");
    assert.equal(permissionAction(childApprovalRules, "task"), "deny");
  });

  it("uses the next native user message as the exclusive fork and revert boundary", () => {
    const first = providerTurn({ id: "turn:first", ordinal: 1, nativeId: "msg-user-1" });
    const synthetic = providerTurn({ id: "turn:synthetic", ordinal: 2, nativeId: null });
    const third = providerTurn({ id: "turn:third", ordinal: 3, nativeId: "msg-user-3" });

    assert.equal(
      openCodeBoundaryAfterProviderTurn([third, first, synthetic], first.id),
      "msg-user-3",
    );
    assert.isUndefined(openCodeBoundaryAfterProviderTurn([first, synthetic, third], third.id));
  });
});
