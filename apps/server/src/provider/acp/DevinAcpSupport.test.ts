import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";
import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  resolveDevinModeId,
} from "./DevinAcpSupport.ts";

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    assert.deepStrictEqual(buildDevinAcpSpawnInput(undefined, "/tmp/project"), {
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("honors the configured binary path", () => {
    assert.deepStrictEqual(
      buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project"),
      {
        command: "/usr/local/bin/devin",
        args: ["acp"],
        cwd: "/tmp/project",
      },
    );
  });

  it.each([
    ["approval-required", ["--permission-mode", "normal", "acp"]],
    ["auto-accept-edits", ["--permission-mode", "accept-edits", "acp"]],
    ["auto", ["--permission-mode", "smart", "acp"]],
    ["full-access", ["--permission-mode", "bypass", "acp"]],
  ] as const)("maps %s to %j", (runtimeMode, args) => {
    assert.deepStrictEqual(
      buildDevinAcpSpawnInput(undefined, "/tmp/project", undefined, runtimeMode).args,
      args,
    );
  });
});

const DEVIN_MODES: AcpSessionModeState["availableModes"] = [
  { id: "accept-edits", name: "Code" },
  { id: "smart", name: "Smart" },
  { id: "ask", name: "Ask" },
  { id: "plan", name: "Plan" },
  { id: "bypass", name: "Bypass Permissions" },
];

function modeState(currentModeId: string): AcpSessionModeState {
  return { currentModeId, availableModes: DEVIN_MODES };
}

describe("resolveDevinModeId", () => {
  it("maps plan interaction mode to Devin's plan mode", () => {
    assert.strictEqual(
      resolveDevinModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: modeState("accept-edits"),
      }),
      "plan",
    );
  });

  it.each([
    ["auto-accept-edits", "accept-edits"],
    ["auto", "smart"],
    ["full-access", "bypass"],
  ] as const)("maps %s to %s", (runtimeMode, expected) => {
    assert.strictEqual(
      resolveDevinModeId({
        interactionMode: "default",
        runtimeMode,
        modeState: modeState("accept-edits"),
      }),
      expected,
    );
  });

  it("leaves approval-required untouched while a writable mode is active", () => {
    assert.isUndefined(
      resolveDevinModeId({
        interactionMode: "default",
        runtimeMode: "approval-required",
        modeState: modeState("accept-edits"),
      }),
    );
  });

  it("escapes a read-only mode for approval-required after a plan turn", () => {
    assert.strictEqual(
      resolveDevinModeId({
        interactionMode: "default",
        runtimeMode: "approval-required",
        modeState: modeState("plan"),
      }),
      "accept-edits",
    );
  });

  it("returns undefined when no mode state is known", () => {
    assert.isUndefined(
      resolveDevinModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: undefined,
      }),
    );
  });
});

describe("applyDevinAcpModelSelection", () => {
  it.effect("applies the model through the model config option", () =>
    Effect.gen(function* () {
      const calls: Array<
        | { readonly type: "model"; readonly value: string }
        | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
      > = [];

      const runtime = {
        getConfigOptions: Effect.succeed([
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: "adaptive",
            options: [{ value: "adaptive", name: "Adaptive" }],
          },
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select" as const,
            currentValue: "accept-edits",
            options: [{ value: "accept-edits", name: "Code" }],
          },
        ]),
        setModel: (value: string) =>
          Effect.sync(() => {
            calls.push({ type: "model", value });
          }),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push({ type: "config", configId, value });
          }),
      };

      yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-high",
        selections: [{ id: "mode", value: "plan" }],
        mapError: ({ cause }) => cause,
      });

      assert.deepStrictEqual(calls, [
        { type: "model", value: "swe-2-high" },
        { type: "config", configId: "mode", value: "plan" },
      ]);
    }),
  );

  it.effect("skips set_model when no model is selected", () =>
    Effect.gen(function* () {
      let called = false;
      const runtime = {
        getConfigOptions: Effect.succeed([] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
        setModel: () =>
          Effect.sync(() => {
            called = true;
          }),
        setConfigOption: () => Effect.void,
      };

      yield* applyDevinAcpModelSelection({
        runtime,
        model: undefined,
        selections: [],
        mapError: ({ cause }) => cause,
      });

      assert.isFalse(called);
    }),
  );
});
