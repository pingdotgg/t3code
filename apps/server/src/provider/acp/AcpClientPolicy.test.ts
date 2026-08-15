// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as NodePath from "node:path";

import {
  acpClientExecuteDisposition,
  acpClientWriteDisposition,
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

describe("client-mediated dispositions", () => {
  const cwd = NodePath.resolve(process.cwd(), "acp-client-policy-workspace");

  it("asks in approval-required mode for both writes and terminals", () => {
    const policy: AcpRuntimePolicy = { runtimeMode: "approval-required", cwd };
    assert.equal(acpClientWriteDisposition(policy, NodePath.join(cwd, "file.ts")), "ask");
    assert.equal(acpClientExecuteDisposition(policy), "ask");
  });

  it("allows in auto and full-access modes without an explicit sandbox", () => {
    for (const runtimeMode of ["auto", "auto-accept-edits", "full-access"] as const) {
      const policy: AcpRuntimePolicy = { runtimeMode, cwd };
      assert.equal(acpClientWriteDisposition(policy, NodePath.join(cwd, "file.ts")), "allow");
      assert.equal(acpClientExecuteDisposition(policy), "allow");
    }
  });

  it("denies writes and terminals under an explicit read-only sandbox", () => {
    const policy: AcpRuntimePolicy = {
      runtimeMode: "full-access",
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    };
    assert.equal(acpClientWriteDisposition(policy, NodePath.join(cwd, "file.ts")), "deny");
    assert.equal(acpClientExecuteDisposition(policy), "deny");
  });

  it("confines writes and denies terminals under an explicit workspace-write sandbox", () => {
    const policy: AcpRuntimePolicy = {
      runtimeMode: "full-access",
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    };
    assert.equal(acpClientWriteDisposition(policy, NodePath.join(cwd, "src/file.ts")), "allow");
    assert.equal(acpClientWriteDisposition(policy, "/tmp/outside-workspace/file.ts"), "deny");
    assert.equal(acpClientExecuteDisposition(policy), "deny");
  });
});

describe("makeAcpClientPolicyGrants", () => {
  const cwd = NodePath.resolve(process.cwd(), "acp-grant-workspace");
  const filePath = NodePath.join(cwd, "src", "granted.ts");

  it("grants writes to approved locations for the approving turn only", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({
      kind: "file-change",
      locations: [filePath],
      cwd,
      scope: "turn",
      turnKey: "turn-1",
    });
    assert.isTrue(grants.allowsWrite({ path: filePath, cwd, turnKey: "turn-1" }));
    assert.isFalse(
      grants.allowsWrite({ path: NodePath.join(cwd, "src", "other.ts"), cwd, turnKey: "turn-1" }),
    );
    assert.isFalse(grants.allowsWrite({ path: filePath, cwd, turnKey: "turn-2" }));
    assert.isFalse(grants.allowsWrite({ path: filePath, cwd, turnKey: null }));
  });

  it("keeps accept-for-session grants across turns", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({
      kind: "file-change",
      locations: [filePath],
      cwd,
      scope: "session",
      turnKey: "turn-1",
    });
    assert.isTrue(grants.allowsWrite({ path: filePath, cwd, turnKey: "turn-9" }));
    assert.isTrue(grants.allowsWrite({ path: filePath, cwd, turnKey: null }));
  });

  it("treats a location-free file change as an unscoped write grant", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({
      kind: "file-change",
      locations: [],
      cwd,
      scope: "turn",
      turnKey: "turn-1",
    });
    assert.isTrue(
      grants.allowsWrite({ path: NodePath.join(cwd, "anything.ts"), cwd, turnKey: "turn-1" }),
    );
    assert.isFalse(
      grants.allowsWrite({ path: NodePath.join(cwd, "anything.ts"), cwd, turnKey: "turn-2" }),
    );
  });

  it("grants terminals only from command approvals and ignores reads", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({
      kind: "file-read",
      locations: [filePath],
      cwd,
      scope: "turn",
      turnKey: "turn-1",
    });
    assert.isFalse(grants.allowsExecute("turn-1"));
    assert.isFalse(grants.allowsWrite({ path: filePath, cwd, turnKey: "turn-1" }));
    grants.recordApproval({
      kind: "command",
      locations: [],
      cwd,
      scope: "turn",
      turnKey: "turn-1",
    });
    assert.isTrue(grants.allowsExecute("turn-1"));
    assert.isFalse(grants.allowsExecute("turn-2"));
    assert.isFalse(grants.allowsExecute(null));
  });

  it("starting a later turn's grants drops the previous turn's grants", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({
      kind: "command",
      locations: [],
      cwd,
      scope: "turn",
      turnKey: "turn-1",
    });
    grants.recordApproval({
      kind: "file-change",
      locations: [filePath],
      cwd,
      scope: "turn",
      turnKey: "turn-2",
    });
    assert.isFalse(grants.allowsExecute("turn-1"));
    assert.isTrue(grants.allowsWrite({ path: filePath, cwd, turnKey: "turn-2" }));
  });

  it.effect("matches grants canonically so symlink escapes stay outside the grant", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-grant-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-grant-outside-",
      });
      yield* fileSystem.makeDirectory(path.join(workspace, "approved"), { recursive: true });
      yield* fileSystem.symlink(outside, path.join(workspace, "approved", "linked"));

      const grants = makeAcpClientPolicyGrants();
      grants.recordApproval({
        kind: "file-change",
        locations: [path.join(workspace, "approved")],
        cwd: workspace,
        scope: "turn",
        turnKey: "turn-1",
      });
      assert.isTrue(
        grants.allowsWrite({
          path: path.join(workspace, "approved", "inside.ts"),
          cwd: workspace,
          turnKey: "turn-1",
        }),
      );
      assert.isFalse(
        grants.allowsWrite({
          path: path.join(workspace, "approved", "linked", "escaped.ts"),
          cwd: workspace,
          turnKey: "turn-1",
        }),
        "a write through an escaping symlink resolves outside the granted root",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
