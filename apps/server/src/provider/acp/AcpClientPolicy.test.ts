// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodePath from "node:path";

import {
  acpAutoApprovalOptionId,
  acpClientExecuteDisposition,
  acpMcpToolApprovalElicitationDisposition,
  acpPermissionDisposition,
  makeAcpClientPolicyGrants,
  type AcpRuntimePolicy,
} from "./AcpClientPolicy.ts";

function permissionRequest(
  kind: NonNullable<EffectAcpSchema.RequestPermissionRequest["toolCall"]["kind"]>,
  locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    options: [],
    sessionId: "permission-session",
    toolCall: {
      kind,
      ...(locations === undefined ? {} : { locations }),
      toolCallId: "permission-tool-call",
    },
  };
}

describe("acpPermissionDisposition", () => {
  const cwd = NodePath.resolve(process.cwd(), "acp-permission-workspace");
  const writableRoot = NodePath.resolve(process.cwd(), "acp-additional-writable-root");
  const policy: AcpRuntimePolicy = {
    runtimeMode: "full-access",
    cwd,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [writableRoot],
      networkAccess: false,
    },
  };

  it("auto-allows mutations only when every location is in cwd or an additional writable root", () => {
    assert.equal(
      acpPermissionDisposition(policy, permissionRequest("edit", [{ path: "src/index.ts" }])),
      "allow",
    );
    assert.equal(
      acpPermissionDisposition(
        policy,
        permissionRequest("delete", [{ path: NodePath.join(writableRoot, "generated.ts") }]),
      ),
      "allow",
    );
    assert.equal(
      acpPermissionDisposition(
        policy,
        permissionRequest("move", [
          { path: NodePath.join(cwd, "from.ts") },
          { path: NodePath.join(writableRoot, "to.ts") },
        ]),
      ),
      "allow",
    );
  });

  it("denies missing or out-of-root mutation locations", () => {
    const outside = NodePath.resolve(process.cwd(), "outside-acp-permission-workspace", "file.ts");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("edit")), "deny");
    assert.equal(
      acpPermissionDisposition(policy, permissionRequest("delete", [{ path: "../escape.ts" }])),
      "deny",
    );
    assert.equal(
      acpPermissionDisposition(
        policy,
        permissionRequest("move", [{ path: NodePath.join(cwd, "inside.ts") }, { path: outside }]),
      ),
      "deny",
    );
  });

  it("keeps non-mutating workspace permissions and denials unchanged", () => {
    assert.equal(acpPermissionDisposition(policy, permissionRequest("read")), "allow");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("execute")), "deny");
  });

  it("auto-accept-edits approves file changes without locations and asks for the rest", () => {
    // ACP permission requests need not carry locations.
    const autoAcceptEdits: AcpRuntimePolicy = { runtimeMode: "auto-accept-edits", cwd };
    for (const kind of ["edit", "delete", "move"] as const) {
      assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind)), "allow");
    }
    for (const kind of ["execute", "fetch", "other"] as const) {
      assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind)), "ask");
    }
    assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest("read")), "allow");
    assert.equal(
      acpPermissionDisposition(
        { ...autoAcceptEdits, approvalPolicy: "on-request" },
        permissionRequest("edit"),
      ),
      "ask",
    );
  });

  it("auto-allows read-kind permission requests under on-request approval", () => {
    for (const runtimePolicy of [
      { ...policy, approvalPolicy: "on-request" },
      { ...policy, approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } },
      { runtimeMode: "approval-required", cwd },
    ] satisfies ReadonlyArray<AcpRuntimePolicy>) {
      for (const kind of ["read", "search", "think"] as const) {
        assert.equal(acpPermissionDisposition(runtimePolicy, permissionRequest(kind)), "allow");
      }
      for (const kind of ["edit", "delete", "move", "execute", "fetch", "other"] as const) {
        assert.equal(acpPermissionDisposition(runtimePolicy, permissionRequest(kind)), "ask");
      }
    }
  });

  it.effect("denies mutations through workspace symlinks that escape the writable roots", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-outside-",
      });
      const outsideFile = path.join(outside, "existing.ts");
      yield* fileSystem.writeFileString(outsideFile, "outside");
      yield* fileSystem.symlink(outsideFile, path.join(workspace, "linked-file.ts"));
      yield* fileSystem.symlink(outside, path.join(workspace, "linked-directory"));

      const realPolicy: AcpRuntimePolicy = {
        runtimeMode: "full-access",
        cwd: workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
        },
      };

      assert.equal(
        acpPermissionDisposition(
          realPolicy,
          permissionRequest("edit", [{ path: "linked-file.ts" }]),
        ),
        "deny",
      );
      assert.equal(
        acpPermissionDisposition(
          realPolicy,
          permissionRequest("edit", [{ path: "linked-directory/new-file.ts" }]),
        ),
        "deny",
        "a missing leaf below an escaping directory symlink must not be auto-approved",
      );
      assert.equal(
        acpPermissionDisposition(
          realPolicy,
          permissionRequest("edit", [{ path: "linked-directory/../escaped-file.ts" }]),
        ),
        "deny",
        "physical symlink traversal must be resolved before parent segments",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows existing and new files beneath canonical writable roots", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-workspace-",
      });
      const workspaceLinkParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-link-parent-",
      });
      const workspaceLink = path.join(workspaceLinkParent, "workspace-link");
      yield* fileSystem.makeDirectory(path.join(workspace, "src"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(workspace, "src", "existing.ts"), "existing");
      yield* fileSystem.symlink(workspace, workspaceLink);

      const realPolicy: AcpRuntimePolicy = {
        runtimeMode: "full-access",
        cwd: workspaceLink,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
        },
      };

      assert.equal(
        acpPermissionDisposition(
          realPolicy,
          permissionRequest("edit", [{ path: "src/existing.ts" }]),
        ),
        "allow",
      );
      assert.equal(
        acpPermissionDisposition(
          realPolicy,
          permissionRequest("edit", [{ path: "src/generated/new-file.ts" }]),
        ),
        "allow",
        "non-existent descendants of a real in-root ancestor remain writable",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("acpMcpToolApprovalElicitationDisposition", () => {
  it("applies runtime policy only to explicitly tagged MCP approval elicitations", () => {
    const fullAccess: AcpRuntimePolicy = {
      runtimeMode: "full-access",
      cwd: process.cwd(),
    };
    const approvalRequired: AcpRuntimePolicy = {
      runtimeMode: "approval-required",
      cwd: process.cwd(),
    };
    const tagged = {
      sessionId: "session-1",
      message: "Approve this request?",
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call" },
    } satisfies EffectAcpSchema.CreateElicitationRequest;

    assert.equal(acpMcpToolApprovalElicitationDisposition(fullAccess, tagged), "allow");
    assert.equal(acpMcpToolApprovalElicitationDisposition(approvalRequired, tagged), "ask");
    // Agents tag approvals for any MCP server; Auto-accept edits only approves edits.
    assert.equal(
      acpMcpToolApprovalElicitationDisposition(
        { runtimeMode: "auto-accept-edits", cwd: process.cwd() },
        tagged,
      ),
      "ask",
    );
    assert.equal(
      acpMcpToolApprovalElicitationDisposition({ runtimeMode: "auto", cwd: process.cwd() }, tagged),
      "allow",
    );
    assert.equal(
      acpMcpToolApprovalElicitationDisposition(
        { ...fullAccess, approvalPolicy: "on-request" },
        tagged,
      ),
      "ask",
    );
    assert.equal(
      acpMcpToolApprovalElicitationDisposition(
        {
          runtimeMode: "auto-accept-edits",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
          },
        },
        tagged,
      ),
      "allow",
    );
    const { _meta: _tag, ...untagged } = tagged;
    assert.equal(
      acpMcpToolApprovalElicitationDisposition(
        fullAccess,
        untagged,
        "mcp_tool_call_approval_exec-123",
      ),
      "allow",
    );
    assert.isUndefined(
      acpMcpToolApprovalElicitationDisposition(fullAccess, {
        ...tagged,
        _meta: { codex_approval_kind: "ordinary_form" },
      }),
    );
    assert.isUndefined(
      acpMcpToolApprovalElicitationDisposition(fullAccess, {
        sessionId: "session-1",
        message: "Authenticate",
        mode: "url",
        elicitationId: "elicitation-1",
        url: "https://example.com/login",
        _meta: { codex_approval_kind: "mcp_tool_call" },
      }),
    );
  });
});

describe("acpAutoApprovalOptionId", () => {
  it("grants once when the agent also offers an always grant", () => {
    const always = { optionId: "always", name: "Always", kind: "allow_always" } as const;
    const request = {
      ...permissionRequest("execute"),
      options: [always, { optionId: "once", name: "Once", kind: "allow_once" }],
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    assert.equal(acpAutoApprovalOptionId(request), "once");
    assert.equal(acpAutoApprovalOptionId({ ...request, options: [always] }), "always");
    assert.isUndefined(
      acpAutoApprovalOptionId({
        ...request,
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      }),
    );
  });
});

describe("client terminal disposition", () => {
  const cwd = NodePath.resolve(process.cwd(), "acp-client-policy-workspace");

  it("asks in approval-required and auto-accept-edits, allows in auto and full access", () => {
    assert.equal(acpClientExecuteDisposition({ runtimeMode: "approval-required", cwd }), "ask");
    assert.equal(acpClientExecuteDisposition({ runtimeMode: "auto-accept-edits", cwd }), "ask");
    assert.equal(acpClientExecuteDisposition({ runtimeMode: "auto", cwd }), "allow");
    assert.equal(acpClientExecuteDisposition({ runtimeMode: "full-access", cwd }), "allow");
  });

  it("denies terminals under explicit read-only and workspace-write sandboxes", () => {
    for (const sandboxPolicy of [
      { type: "readOnly" },
      { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    ]) {
      assert.equal(
        acpClientExecuteDisposition({
          runtimeMode: "full-access",
          cwd,
          approvalPolicy: "never",
          sandboxPolicy,
        }),
        "deny",
      );
    }
  });
});

describe("makeAcpClientPolicyGrants", () => {
  it("grants terminals only from commands, never from an approved read or edit", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({ kind: "file-read", scope: "turn", turnKey: "turn-1" });
    grants.recordApproval({ kind: "file-change", scope: "session", turnKey: "turn-1" });
    assert.isFalse(grants.allowsExecute("turn-1"));
    grants.recordApproval({ kind: "command", scope: "turn", turnKey: "turn-1" });
    assert.isTrue(grants.allowsExecute("turn-1"));
    assert.isFalse(grants.allowsExecute("turn-2"));
    assert.isFalse(grants.allowsExecute(null));
  });

  it("keeps accept-for-session command grants across turns", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({ kind: "command", scope: "session", turnKey: "turn-1" });
    assert.isTrue(grants.allowsExecute("turn-9"));
    assert.isTrue(grants.allowsExecute(null));
  });

  it("drops a turn's command grant when a later turn approves one", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({ kind: "command", scope: "turn", turnKey: "turn-1" });
    grants.recordApproval({ kind: "command", scope: "turn", turnKey: "turn-2" });
    assert.isFalse(grants.allowsExecute("turn-1"));
    assert.isTrue(grants.allowsExecute("turn-2"));
  });
});
