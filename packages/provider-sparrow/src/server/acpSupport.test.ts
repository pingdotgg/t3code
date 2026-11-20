import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { AcpSessionRuntime } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { SparrowSettings } from "../settings.ts";
import {
  applySparrowModelSelection,
  buildSparrowAcpSpawnInput,
  buildSparrowThoughtLevelDescriptor,
  encodeSparrowAcpModelId,
  parseSparrowModelRef,
  sparrowApprovalOptions,
  sparrowPermissionDisposition,
  sparrowPermissionModeForPolicy,
} from "./acpSupport.ts";

const INSTANCE_ID = ProviderInstanceId.make("sparrow");
const decodeSparrowSettings = Schema.decodeSync(SparrowSettings);

describe("parseSparrowModelRef & encodeSparrowAcpModelId", () => {
  it("encodes provider slashes and percents while keeping model slashes literal", () => {
    assert.equal(
      encodeSparrowAcpModelId("provider/name%1", "org/model"),
      "provider%2Fname%251/org/model",
    );
  });

  it("parses bracketed and unbracketed model references with optional thinking level", () => {
    assert.deepEqual(parseSparrowModelRef("magpie/<group/flash>/max"), {
      provider: "magpie",
      modelId: "group/flash",
      acpModelId: "magpie/group/flash",
      thinkingLevel: "max",
    });
    assert.deepEqual(parseSparrowModelRef("<provider/name>/<org/model>/high"), {
      provider: "provider/name",
      modelId: "org/model",
      acpModelId: "provider%2Fname/org/model",
      thinkingLevel: "high",
    });
    assert.deepEqual(parseSparrowModelRef("deepseek/flash/off"), {
      provider: "deepseek",
      modelId: "flash",
      acpModelId: "deepseek/flash",
      thinkingLevel: "off",
    });
    assert.deepEqual(parseSparrowModelRef("openai-codex/gpt-5.5"), {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      acpModelId: "openai-codex/gpt-5.5",
    });
    assert.isUndefined(parseSparrowModelRef("   "));
  });
});

describe("buildSparrowThoughtLevelDescriptor", () => {
  it("returns undefined for non-reasoning models without mapped variants", () => {
    assert.isUndefined(buildSparrowThoughtLevelDescriptor({ reasoning: false }));
  });

  it("filters levels by thinkingLevelMap and preserves custom labels", () => {
    const descriptor = buildSparrowThoughtLevelDescriptor({
      reasoning: true,
      thinkingLevelMap: { off: "Thinking off", minimal: null, high: "Thinking on" },
      defaultLevel: "high",
    });
    assert.deepEqual(descriptor, {
      id: "thought_level",
      label: "Thinking",
      type: "select",
      role: "reasoning",
      currentValue: "high",
      options: [
        { id: "off", label: "Thinking off" },
        { id: "high", label: "Thinking on", isDefault: true },
      ],
    });
  });
});

describe("buildSparrowAcpSpawnInput", () => {
  it("appends --acp after launchArgs and applies custom homePath", () => {
    const settings = decodeSparrowSettings({
      binaryPath: "/usr/local/bin/sparrow",
      homePath: "/tmp/sparrow-home",
      launchArgs: '--log-level "debug"',
    });
    const spawn = buildSparrowAcpSpawnInput(settings, "/workspace", { PATH: "/usr/bin" });
    assert.deepEqual(spawn.command, "/usr/local/bin/sparrow");
    assert.deepEqual(spawn.args, ["--log-level", "debug", "--acp"]);
    assert.equal(spawn.cwd, "/workspace");
    assert.equal(spawn.env?.HOME, "/tmp/sparrow-home");
    assert.equal(spawn.env?.PATH, "/usr/bin");
  });
});

describe("sparrow permission policy", () => {
  it("maps allow_once, allow_always (session), and reject_once options cleanly", () => {
    const request = {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", kind: "execute" as const, locations: [{ path: "/ws/a" }] },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
        { optionId: "allow_session", name: "Allow for session", kind: "allow_always" as const },
        { optionId: "deny", name: "Deny", kind: "reject_once" as const },
      ],
    };
    assert.deepEqual(sparrowApprovalOptions(request), [
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Always allow" },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
    assert.equal(
      sparrowPermissionDisposition({ runtimeMode: "full-access", cwd: "/ws" }, request),
      "allow",
    );
    // Without allow_once, policy auto-approval falls back to ask instead of silently latching allow_session.
    const sessionOnly = {
      ...request,
      options: request.options.filter((option) => option.kind !== "allow_once"),
    };
    assert.equal(
      sparrowPermissionDisposition({ runtimeMode: "full-access", cwd: "/ws" }, sessionOnly),
      "ask",
    );

    assert.equal(
      sparrowPermissionModeForPolicy({
        runtimeMode: "full-access",
        sandboxPolicy: { type: "readOnly" },
      }),
      "read_only",
    );
    assert.equal(
      sparrowPermissionModeForPolicy({
        runtimeMode: "auto",
        sandboxPolicy: { type: "workspaceWrite" },
      }),
      "workspace_write",
    );
    assert.equal(sparrowPermissionModeForPolicy({ runtimeMode: "auto" }), "workspace_write");
    assert.equal(sparrowPermissionModeForPolicy({ runtimeMode: "full-access" }), "full_access");
    assert.equal(
      sparrowPermissionModeForPolicy({
        runtimeMode: "approval-required",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
      "workspace_write",
    );

    const cwd = `${process.cwd()}/sparrow-policy-ws`;
    const autoEdits = { runtimeMode: "auto-accept-edits" as const, cwd };
    assert.equal(
      sparrowPermissionDisposition(autoEdits, {
        ...request,
        toolCall: {
          toolCallId: "t-in",
          kind: "edit",
          locations: [{ path: `${cwd}/src/app.ts` }],
        },
      }),
      "allow",
    );
    assert.equal(
      sparrowPermissionDisposition(autoEdits, {
        ...request,
        toolCall: {
          toolCallId: "t-out",
          kind: "edit",
          locations: [{ path: "/etc/hosts" }],
        },
      }),
      "ask",
    );

    const restrictedReadOnly = {
      runtimeMode: "approval-required" as const,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "readOnly",
        access: {
          type: "restricted",
          includePlatformDefaults: false,
          readableRoots: ["allowed"],
        },
        networkAccess: false,
      },
    };
    assert.equal(
      sparrowPermissionDisposition(restrictedReadOnly, {
        ...request,
        toolCall: {
          toolCallId: "r-allow",
          kind: "read",
          title: "read: read",
          locations: [{ path: `${cwd}/allowed/doc.md` }],
        },
      }),
      "allow",
    );
    assert.equal(
      sparrowPermissionDisposition(restrictedReadOnly, {
        ...request,
        toolCall: {
          toolCallId: "r-deny",
          kind: "read",
          title: "read: read",
          locations: [{ path: `${cwd}/secret.txt` }],
        },
      }),
      "deny",
    );
    assert.equal(
      sparrowPermissionDisposition(restrictedReadOnly, {
        ...request,
        toolCall: { toolCallId: "s-deny", kind: "search", title: "search: web_search" },
      }),
      "deny",
    );

    const sparrowReadOnly = { runtimeMode: "read-only" as const, cwd };
    assert.equal(sparrowPermissionModeForPolicy(sparrowReadOnly), "read_only");
    assert.equal(
      sparrowPermissionDisposition(sparrowReadOnly, {
        ...request,
        toolCall: { toolCallId: "ro-read", kind: "read", title: "read: read" },
      }),
      "allow",
    );
    assert.equal(
      sparrowPermissionDisposition(sparrowReadOnly, {
        ...request,
        toolCall: { toolCallId: "ro-write", kind: "edit", locations: [{ path: `${cwd}/a.ts` }] },
      }),
      "deny",
    );

    const sparrowWorkspaceWrite = { runtimeMode: "workspace-write" as const, cwd };
    assert.equal(sparrowPermissionModeForPolicy(sparrowWorkspaceWrite), "workspace_write");
    assert.equal(
      sparrowPermissionDisposition(sparrowWorkspaceWrite, {
        ...request,
        toolCall: { toolCallId: "ww-edit-in", kind: "edit", locations: [{ path: `${cwd}/a.ts` }] },
      }),
      "allow",
    );
    assert.equal(
      sparrowPermissionDisposition(sparrowWorkspaceWrite, {
        ...request,
        toolCall: { toolCallId: "ww-edit-out", kind: "edit", locations: [{ path: "/etc/hosts" }] },
      }),
      "ask",
    );
    assert.equal(
      sparrowPermissionDisposition(sparrowWorkspaceWrite, {
        ...request,
        toolCall: { toolCallId: "ww-bash", kind: "execute", title: "execute: bash" },
      }),
      "allow",
    );
    assert.equal(
      sparrowPermissionDisposition(sparrowWorkspaceWrite, {
        ...request,
        _meta: { "sparrow/escalated": true },
        toolCall: {
          toolCallId: "ww-bash-escalated",
          kind: "execute",
          title: "execute: bash — install system tool",
        },
      }),
      "ask",
    );
    assert.equal(
      sparrowPermissionDisposition(sparrowWorkspaceWrite, {
        ...request,
        toolCall: { toolCallId: "ww-mcp", kind: "other", title: "other: mcp" },
      }),
      "ask",
    );
  });
});

describe("applySparrowModelSelection", () => {
  it.effect(
    "switches model before applying thought_level and ignores stale unsupported levels",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ id: string; value: string | boolean }> = [];
        const optionsRef = Ref.make([
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: "openai-codex/gpt-5.5",
            options: [
              { value: "openai-codex/gpt-5.5", name: "GPT-5.5" },
              { value: "magpie/group/flash", name: "Magpie Flash" },
            ],
          },
          {
            id: "thought_level",
            name: "Thinking",
            category: "thought_level",
            type: "select" as const,
            currentValue: "medium",
            options: [
              { value: "medium", name: "Medium" },
              { value: "max", name: "Max" },
            ],
          },
        ]);
        const currentOptions = yield* optionsRef;
        const runtime = {
          getConfigOptions: Ref.get(currentOptions),
          setConfigOption: (configId: string, value: string | boolean) =>
            Effect.sync(() => {
              calls.push({ id: configId, value });
            }).pipe(
              Effect.andThen(
                configId === "model" && value === "magpie/group/flash"
                  ? Ref.set(currentOptions, [
                      {
                        id: "model",
                        name: "Model",
                        category: "model",
                        type: "select" as const,
                        currentValue: "magpie/group/flash",
                        options: [
                          { value: "openai-codex/gpt-5.5", name: "GPT-5.5" },
                          { value: "magpie/group/flash", name: "Magpie Flash" },
                        ],
                      },
                      {
                        id: "thought_level",
                        name: "Thinking",
                        category: "thought_level",
                        type: "select" as const,
                        currentValue: "high",
                        options: [
                          { value: "high", name: "High" },
                          { value: "max", name: "Max" },
                        ],
                      },
                    ])
                  : Effect.void,
              ),
              Effect.as({ configOptions: [] }),
            ),
        } as unknown as AcpSessionRuntime["Service"];

        const startResult = {} as Parameters<typeof applySparrowModelSelection>[0]["startResult"];
        const selection = createModelSelection(INSTANCE_ID, "magpie/group/flash", [
          { id: "thought_level", value: "max" },
        ]);
        const applied = yield* applySparrowModelSelection({
          runtime,
          startResult,
          modelSelection: selection,
        });
        assert.equal(applied, "magpie/group/flash");
        assert.deepEqual(calls, [
          { id: "model", value: "magpie/group/flash" },
          { id: "thought_level", value: "max" },
        ]);

        // Unlisted stale thought level after model change is skipped rather than failing.
        calls.length = 0;
        const staleApplied = yield* applySparrowModelSelection({
          runtime,
          startResult,
          modelSelection: createModelSelection(INSTANCE_ID, "default", [
            { id: "thought_level", value: "minimal" },
          ]),
        });
        assert.equal(staleApplied, "magpie/group/flash");
        assert.deepEqual(calls, []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
