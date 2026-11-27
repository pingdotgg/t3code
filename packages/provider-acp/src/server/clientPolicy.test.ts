// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodePath from "node:path";

import {
  acpChangedPathsOfToolCall,
  acpClientExecuteDisposition,
  acpMcpToolApprovalElicitationDisposition,
  acpPermissionDisposition,
  acpReadRequiresApprovalForUnownedAttachment,
  acpReadTargetsInRoot,
  makeAcpClientPolicyGrants,
  mergeAcpChangedPaths,
  type AcpRuntimePolicy,
} from "./clientPolicy.ts";

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
    // A multi-folder thread's other folders are writable roots too.
    const tracked: AcpRuntimePolicy = {
      ...policy,
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
      workspace: { extraRoots: [writableRoot] },
    };
    const edit = (path: string) =>
      acpPermissionDisposition(tracked, permissionRequest("edit", [{ path }]));
    assert.equal(edit(NodePath.join(writableRoot, "generated.ts")), "allow");
    assert.equal(edit(NodePath.resolve(process.cwd(), "untracked-folder", "file.ts")), "deny");
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

  it("auto-accept-edits approves file changes inside the thread's folders and asks for the rest", () => {
    const autoAcceptEdits: AcpRuntimePolicy = { runtimeMode: "auto-accept-edits", cwd };
    const outside = NodePath.resolve(process.cwd(), "outside-acp-permission-workspace", "file.ts");
    for (const kind of ["edit", "delete", "move"] as const) {
      assert.equal(
        acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind, [{ path: "src/a.ts" }])),
        "allow",
      );
      assert.equal(
        acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind, [{ path: outside }])),
        "ask",
      );
      assert.equal(
        acpPermissionDisposition(
          autoAcceptEdits,
          permissionRequest(kind, [{ path: NodePath.join(cwd, "inside.ts") }, { path: outside }]),
        ),
        "ask",
      );
      assert.equal(
        acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind, [{ path: "../up.ts" }])),
        "ask",
      );
      // Without a location there is no folder to check, so the user decides.
      assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind)), "ask");
    }
    // A multi-folder thread's other folders count as its own.
    assert.equal(
      acpPermissionDisposition(
        { ...autoAcceptEdits, workspace: { extraRoots: [writableRoot] } },
        permissionRequest("edit", [{ path: NodePath.join(writableRoot, "generated.ts") }]),
      ),
      "allow",
    );
    for (const kind of ["execute", "fetch", "other"] as const) {
      assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind)), "ask");
    }
    assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest("read")), "allow");
    assert.equal(
      acpPermissionDisposition(
        { ...autoAcceptEdits, approvalPolicy: "on-request" },
        permissionRequest("edit", [{ path: "src/a.ts" }]),
      ),
      "ask",
    );
    // Full access and Auto are not narrowed.
    for (const runtimeMode of ["full-access", "auto"] as const) {
      assert.equal(
        acpPermissionDisposition(
          { runtimeMode, cwd },
          permissionRequest("edit", [{ path: outside }]),
        ),
        "allow",
      );
    }
  });

  it.effect("auto-accept-edits asks for edits that leave the folder through a link", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-outside-",
      });
      yield* fileSystem.symlink(outside, path.join(workspace, "linked-directory"));
      yield* fileSystem.makeDirectory(path.join(workspace, "src"));
      const autoAcceptEdits: AcpRuntimePolicy = {
        runtimeMode: "auto-accept-edits",
        cwd: workspace,
      };
      const edit = (target: string) =>
        acpPermissionDisposition(autoAcceptEdits, permissionRequest("edit", [{ path: target }]));

      assert.equal(edit("src/new-file.ts"), "allow");
      assert.equal(edit("linked-directory/new-file.ts"), "ask");
      assert.equal(edit(path.join(outside, "new-file.ts")), "ask");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("checks a file change's path exactly as the agent sent it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-permission-outside-",
      });
      // Two different files on POSIX: `target` stays in the folder, `target ` leads out of it.
      yield* fileSystem.writeFileString(path.join(workspace, "target"), "");
      yield* fileSystem.symlink(path.join(outside, "file"), path.join(workspace, "target "));
      yield* fileSystem.symlink(outside, path.join(workspace, " linked"));
      yield* fileSystem.makeDirectory(path.join(workspace, "linked"));
      const disposition = (sandboxPolicy: AcpRuntimePolicy["sandboxPolicy"], target: string) =>
        acpPermissionDisposition(
          {
            runtimeMode: sandboxPolicy === undefined ? "auto-accept-edits" : "full-access",
            cwd: workspace,
            ...(sandboxPolicy === undefined ? {} : { approvalPolicy: "never", sandboxPolicy }),
          },
          permissionRequest("edit", [{ path: target }]),
        );
      for (const [sandboxPolicy, refused] of [
        [undefined, "ask"],
        [{ type: "workspaceWrite", writableRoots: [] }, "deny"],
      ] as const) {
        assert.equal(disposition(sandboxPolicy, path.join(workspace, "target")), "allow");
        assert.equal(disposition(sandboxPolicy, "target"), "allow");
        assert.equal(disposition(sandboxPolicy, "linked/new.ts"), "allow");
        if (NodePath.sep !== "/") continue;
        assert.equal(disposition(sandboxPolicy, path.join(workspace, "target ")), refused);
        assert.equal(disposition(sandboxPolicy, "target "), refused);
        assert.equal(disposition(sandboxPolicy, " linked/new.ts"), refused);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("asks about a file change whose path may mean another file to the agent", () => {
    const autoAcceptEdits: AcpRuntimePolicy = { runtimeMode: "auto-accept-edits", cwd };
    const edit = (path: unknown) =>
      acpPermissionDisposition(
        autoAcceptEdits,
        permissionRequest("edit", [{ path }] as ReadonlyArray<EffectAcpSchema.ToolCallLocation>),
      );
    assert.equal(edit("src/a.ts"), "allow");
    assert.equal(edit("./src/../src/a.ts"), "allow");
    for (const path of [
      "",
      " ",
      "\n",
      7,
      null,
      undefined,
      ["src/a.ts"],
      "~",
      "~/notes.txt",
      "~other/notes.txt",
      `file://${cwd}/src/a.ts`,
      "file:src/a.ts",
      "vscode-remote://host/src/a.ts",
      "src/a.ts\0",
      `${cwd}/src/a.ts\0.png`,
      "src/../../up.ts",
      `${cwd}/../up.ts`,
    ]) {
      assert.equal(edit(path), "ask", JSON.stringify(path));
    }
    if (NodePath.sep === "/") {
      for (const path of ["C:\\work\\a.ts", "C:a.ts", "\\\\host\\share\\a.ts", "src\\..\\a.ts"]) {
        assert.equal(edit(path), "ask", path);
      }
    }
  });

  it("reads a request's diffs and raw input as well as its locations", () => {
    const autoAcceptEdits: AcpRuntimePolicy = { runtimeMode: "auto-accept-edits", cwd };
    const outside = NodePath.resolve(process.cwd(), "outside-acp-permission-workspace", "file.ts");
    const edit = (toolCall: Record<string, unknown>) =>
      acpPermissionDisposition(autoAcceptEdits, {
        options: [],
        sessionId: "permission-session",
        toolCall: { kind: "edit", toolCallId: "permission-tool-call", ...toolCall },
      } as EffectAcpSchema.RequestPermissionRequest);
    const inside = [{ path: "src/a.ts" }];
    assert.equal(edit({ locations: inside, rawInput: { path: "src/a.ts" } }), "allow");
    assert.equal(edit({ content: [{ type: "diff", path: "src/a.ts", newText: "" }] }), "allow");
    assert.equal(edit({ rawInput: { file_path: "src/a.ts", command: "write" } }), "allow");
    for (const toolCall of [
      { locations: inside, content: [{ type: "diff", path: outside, newText: "" }] },
      { locations: inside, rawInput: { path: outside } },
      // The same key under another spelling still counts.
      { locations: inside, rawInput: { path: "src/a.ts", filePath: outside } },
      { locations: inside, rawInput: { path: "src/a.ts", file_path: outside } },
      { locations: inside, rawInput: { path: 7 } },
      { locations: inside, rawInput: { path: " " } },
      { locations: inside, content: [{ type: "diff", newText: "" }] },
      { locations: inside, content: [{ type: "diff", changes: {} }] },
      { locations: inside, content: [{ type: "_t3_unknown", originalType: "_patch", raw: {} }] },
      { locations: inside, content: "diff" },
      { locations: { path: "src/a.ts" } },
      // A diff that carries a path beside its changes changes both.
      {
        content: [
          { type: "diff", path: outside, changes: [{ operation: "modify", path: "src/a.ts" }] },
        ],
      },
      { content: [{ type: "diff", changes: [{ operation: "_swap", path: "src/a.ts" }] }] },
      {
        content: [
          { type: "diff", changes: [{ operation: "move", oldPath: outside, path: "src/a.ts" }] },
        ],
      },
      { content: [{ type: "diff", changes: [{ operation: "move", path: "src/a.ts" }] }] },
      // No path at all.
      {},
      { locations: [] },
      { rawInput: "src/a.ts" },
    ]) {
      assert.equal(edit(toolCall), "ask", JSON.stringify(toolCall));
    }
  });

  it("does not approve a file change that names very many paths", () => {
    const autoAcceptEdits: AcpRuntimePolicy = { runtimeMode: "auto-accept-edits", cwd };
    const edit = (count: number) =>
      acpPermissionDisposition(
        autoAcceptEdits,
        permissionRequest(
          "edit",
          Array.from({ length: count }, (_, index) => ({ path: `src/${index}.ts` })),
        ),
      );
    assert.equal(edit(256), "allow");
    assert.equal(edit(257), "ask");
    // The same path named again is one path.
    assert.equal(
      acpPermissionDisposition(
        autoAcceptEdits,
        permissionRequest(
          "edit",
          Array.from({ length: 1_000 }, () => ({ path: "src/a.ts" })),
        ),
      ),
      "allow",
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

describe("acpChangedPathsOfToolCall", () => {
  it("names every path of the locations, diffs and raw input once, as sent", () => {
    assert.deepEqual(
      acpChangedPathsOfToolCall({
        locations: [{ path: "/work/a.ts", line: 3 }, { path: " /work/a.ts" }],
        content: [
          { type: "content", content: { type: "text", text: "/elsewhere/ignored.ts" } },
          { type: "terminal", terminalId: "terminal-1" },
          { type: "diff", path: "/work/b.ts ", newText: "b" },
          {
            type: "diff",
            changes: [
              { operation: "add", path: "/work/c.ts" },
              { operation: "delete", path: "/work/d.ts" },
              { operation: "modify", path: "/work/a.ts" },
              { operation: "move", oldPath: "/work/e.ts", path: "/work/f.ts" },
              // A copy only reads its source.
              { operation: "copy", oldPath: "/elsewhere/g.ts", path: "/work/g.ts" },
            ],
          },
        ],
        rawInput: { path: "/work/a.ts", filePath: "/work/h.ts", file_path: null, other: 7 },
      }),
      [
        "/work/a.ts",
        " /work/a.ts",
        "/work/b.ts ",
        "/work/c.ts",
        "/work/d.ts",
        "/work/e.ts",
        "/work/f.ts",
        "/work/g.ts",
        "/work/h.ts",
      ],
    );
    assert.deepEqual(acpChangedPathsOfToolCall({}), []);
    assert.deepEqual(
      acpChangedPathsOfToolCall({ locations: null, content: null, rawInput: null }),
      [],
    );
  });

  it("merges two readings into every path of both, and unknown stays unknown", () => {
    assert.deepEqual(mergeAcpChangedPaths(["/a", "/b"], ["/b", "/c"]), ["/a", "/b", "/c"]);
    assert.deepEqual(mergeAcpChangedPaths(undefined, ["/a"]), ["/a"]);
    assert.deepEqual(mergeAcpChangedPaths(["/a"], undefined), ["/a"]);
    assert.deepEqual(mergeAcpChangedPaths(undefined, undefined), []);
    assert.equal(mergeAcpChangedPaths("unknown", ["/a"]), "unknown");
    assert.equal(mergeAcpChangedPaths(["/a"], "unknown"), "unknown");
    assert.equal(mergeAcpChangedPaths("unknown", undefined), "unknown");
  });
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
  it("grants terminals only from execute approvals, never from any other approved kind", () => {
    const grants = makeAcpClientPolicyGrants();
    for (const toolKind of ["read", "edit", "switch_mode", "other", "unknown", "browse"]) {
      grants.recordApproval({ toolKind, scope: "session", turnKey: "turn-1" });
    }
    assert.isFalse(grants.allowsExecute("turn-1"));
    grants.recordApproval({ toolKind: "execute", scope: "turn", turnKey: "turn-1" });
    assert.isTrue(grants.allowsExecute("turn-1"));
    assert.isFalse(grants.allowsExecute("turn-2"));
    assert.isFalse(grants.allowsExecute(null));
  });

  it("keeps accept-for-session command grants across turns", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({ toolKind: "execute", scope: "session", turnKey: "turn-1" });
    assert.isTrue(grants.allowsExecute("turn-9"));
    assert.isTrue(grants.allowsExecute(null));
  });

  it("drops a turn's command grant when a later turn approves one", () => {
    const grants = makeAcpClientPolicyGrants();
    grants.recordApproval({ toolKind: "execute", scope: "turn", turnKey: "turn-1" });
    grants.recordApproval({ toolKind: "execute", scope: "turn", turnKey: "turn-2" });
    assert.isFalse(grants.allowsExecute("turn-1"));
    assert.isTrue(grants.allowsExecute("turn-2"));
  });
});

describe("acpReadTargetsInRoot", () => {
  it.effect(
    "identifies attachment targets, extra flavor keys, empty fields, and web searches",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const root = NodePath.join(cwd, "attachments");
        const file = NodePath.join(root, "a.txt");
        const sub = NodePath.join(root, "sub");
        yield* fileSystem.makeDirectory(sub, { recursive: true });
        yield* fileSystem.writeFileString(file, "secret");
        yield* fileSystem.writeFileString(NodePath.join(cwd, "a.txt"), "decoy");
        yield* fileSystem.symlink(root, NodePath.join(cwd, "linked"));
        yield* fileSystem.symlink(sub, NodePath.join(cwd, "sub-link"));

        const extraPathKeys = ["AbsolutePath", "SearchPath", "TargetFile", "TargetDirectory"];
        const targets = (toolCall: Parameters<typeof acpReadTargetsInRoot>[0]["toolCall"]) =>
          acpReadTargetsInRoot({ cwd, root, homeDir: cwd, extraPathKeys, toolCall });

        assert.deepEqual(targets({ rawInput: { AbsolutePath: file } }), [file]);
        assert.deepEqual(targets({ locations: [{ path: "linked/a.txt" }] }), [file]);
        assert.deepEqual(targets({ rawInput: { path: "~/attachments/a.txt" } }), [file]);
        assert.deepEqual(targets({ rawInput: { path: "~/sub-link/../a.txt" } }), [file]);
        assert.deepEqual(targets({ rawInput: { SearchPath: "~" } }), [null]);
        assert.deepEqual(targets({ kind: "search", rawInput: { query: "effect ts" } }), []);
        assert.deepEqual(
          acpReadTargetsInRoot({
            cwd: null,
            root,
            extraPathKeys,
            toolCall: { kind: "search", rawInput: { query: "effect ts" } },
          }),
          [],
        );
        assert.deepEqual(targets({ rawInput: { path: "", SearchPath: "  " } }), []);
        assert.deepEqual(targets({ rawInput: { SearchPath: cwd } }), [null]);
        assert.deepEqual(targets({ rawInput: { path: NodePath.join(cwd, "missing.txt") } }), []);
        assert.equal(targets({ rawInput: { SearchPath: "~other/file" } }), "unknown");

        assert.isTrue(acpReadRequiresApprovalForUnownedAttachment({ runtimeMode: "auto", cwd }));
        assert.isTrue(
          acpReadRequiresApprovalForUnownedAttachment({
            runtimeMode: "full-access",
            cwd,
            sandboxPolicy: { type: "readOnly" },
          }),
        );
        assert.isFalse(
          acpReadRequiresApprovalForUnownedAttachment({ runtimeMode: "full-access", cwd }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
