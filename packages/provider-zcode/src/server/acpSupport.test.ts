import { describe, expect, it } from "@effect/vitest";

import type * as EffectAcpSchema from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyZCodeAcpModelSelection,
  buildZCodeAcpSpawnInput,
  normalizeZCodeSessionUpdate,
  zcodeApprovalOptions,
  zcodePermissionMode,
  zcodePromptFailure,
} from "./acpSupport.ts";

const SETTINGS = { binaryPath: "zcode-acp-server", zcodeBinaryPath: "" };

describe("zcodePermissionMode", () => {
  it("maps each offered runtime mode to the ZCode mode that enforces it", () => {
    expect(zcodePermissionMode("approval-required")).toBe("build");
    expect(zcodePermissionMode("auto-accept-edits")).toBe("edit");
    expect(zcodePermissionMode("full-access")).toBe("yolo");
  });

  it("runs unoffered modes asking instead of in ZCode's tool-denying auto mode", () => {
    expect(zcodePermissionMode("auto")).toBe("build");
    expect(zcodePermissionMode(undefined)).toBe("build");
  });
});

describe("buildZCodeAcpSpawnInput", () => {
  it("launches the bridge in the runtime mode with quota auto-resume off", () => {
    const spawn = buildZCodeAcpSpawnInput(SETTINGS, "/work", { PATH: "/bin" }, "full-access");
    expect(spawn).toEqual({
      command: "zcode-acp-server",
      args: [],
      cwd: "/work",
      env: { PATH: "/bin", ZCODE_ACP_MODE: "yolo", ZCODE_ACP_QUOTA_AUTO_RESUME: "0" },
    });
  });

  it("points the bridge at a configured ZCode CLI", () => {
    const spawn = buildZCodeAcpSpawnInput(
      { binaryPath: "/opt/bridge", zcodeBinaryPath: " /opt/zcode.cjs " },
      "/work",
      {},
    );
    expect(spawn.command).toBe("/opt/bridge");
    expect(spawn.env?.ZCODE_BIN).toBe("/opt/zcode.cjs");
    expect(spawn.env?.ZCODE_ACP_MODE).toBe("build");
  });

  it("never inherits the bridge's remote-access settings", () => {
    const spawn = buildZCodeAcpSpawnInput(SETTINGS, "/work", {
      ZCODE_ACP_REMOTE: "1",
      ZCODE_ACP_REMOTE_TOKEN: "example-token",
      ZCODE_HOME: "/data/zcode",
    });
    expect(spawn.env).not.toHaveProperty("ZCODE_ACP_REMOTE");
    expect(spawn.env).not.toHaveProperty("ZCODE_ACP_REMOTE_TOKEN");
    expect(spawn.env?.ZCODE_HOME).toBe("/data/zcode");
  });
});

describe("normalizeZCodeSessionUpdate", () => {
  const chunk = (messageId: string, text: string): EffectAcpSchema.SessionNotification => ({
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    },
  });

  it("blanks the bridge's turn status line", () => {
    const normalized = normalizeZCodeSessionUpdate(chunk("turninfo_m1", "✓ completed · cache 7/8"));
    expect(normalized.update).toMatchObject({ content: { type: "text", text: "" } });
  });

  it("keeps the agent's reply text", () => {
    const notification = chunk("msg_m1", "PONG");
    expect(normalizeZCodeSessionUpdate(notification)).toBe(notification);
  });
});

describe("zcodePromptFailure", () => {
  const turnFailed = (data: unknown) =>
    new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "ZCode turn failed: usage cap reached",
      data,
    });

  it("classifies a GLM usage cap as a usage limit with its reset time", () => {
    const failure = zcodePromptFailure(
      turnFailed({ type: "zcode_turn_failed", providerCode: "1308", retryAfterMs: 60_000 }),
      () => Date.UTC(2026, 0, 1),
    );
    expect(failure).toMatchObject({
      class: "usage_limit",
      code: "1308",
      resetAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("keeps the usage limit but drops a reset time it cannot represent", () => {
    for (const retryAfterMs of [-1, 1e300]) {
      const failure = zcodePromptFailure(
        turnFailed({ type: "zcode_turn_failed", providerCode: "1308", retryAfterMs }),
        () => Date.UTC(2026, 0, 1),
      );
      expect(failure.class).toBe("usage_limit");
      expect(failure.resetAt).toBeUndefined();
    }
  });

  it("reports other turn failures as provider errors", () => {
    const failure = zcodePromptFailure(
      turnFailed({ type: "zcode_turn_failed", providerCode: "500", retryable: true }),
    );
    expect(failure).toMatchObject({ class: "provider_error", code: "500", retryable: true });
  });

  it("keeps the JSON-RPC code when the bridge sends no failure data", () => {
    expect(zcodePromptFailure(turnFailed(undefined))).toMatchObject({
      class: "provider_error",
      code: "-32603",
    });
  });
});

describe("applyZCodeAcpModelSelection", () => {
  const modelOption: EffectAcpSchema.SessionConfigOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "plan\\GLM-Example",
    options: [
      { value: "plan\\GLM-Example", name: "GLM Example" },
      { value: "plan\\GLM-Example-Flash", name: "GLM Example Flash" },
    ],
  };
  const makeRuntime = () => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    return {
      calls,
      runtime: {
        getConfigOptions: Effect.succeed([modelOption]),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push({ configId, value });
            return { configOptions: [] };
          }),
      },
    };
  };

  it.effect("keeps the session's model for the default alias", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeRuntime();
      const model = yield* applyZCodeAcpModelSelection({
        runtime,
        model: "zcode-default",
        mapError: (cause) => cause,
      });
      expect(model).toBe("plan\\GLM-Example");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("switches to an offered model", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeRuntime();
      const model = yield* applyZCodeAcpModelSelection({
        runtime,
        model: "plan\\GLM-Example-Flash",
        mapError: (cause) => cause,
      });
      expect(model).toBe("plan\\GLM-Example-Flash");
      expect(calls).toEqual([{ configId: "model", value: "plan\\GLM-Example-Flash" }]);
    }),
  );

  it.effect("fails instead of running a model the account does not offer", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeRuntime();
      const error = yield* applyZCodeAcpModelSelection({
        runtime,
        model: "plan\\Retired",
        mapError: (cause) => cause,
      }).pipe(Effect.flip);
      expect(error.message).toContain("plan\\Retired");
      expect(calls).toEqual([]);
    }),
  );
});

describe("zcodeApprovalOptions", () => {
  it("never offers ZCode's project-wide grant as a session choice", () => {
    const request = {
      sessionId: "session-1",
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "allow_project", kind: "allow_always", name: "Always allow in this project" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
      toolCall: { toolCallId: "call-1", title: "Bash: touch file" },
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    expect(zcodeApprovalOptions(request).map((option) => option.decision)).toEqual([
      "cancel",
      "decline",
      "accept",
    ]);
  });
});
