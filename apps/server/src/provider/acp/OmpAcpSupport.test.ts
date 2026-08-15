import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";

import { applyOmpAcpModelSelection, buildOmpAcpSpawnInput } from "./OmpAcpSupport.ts";

describe("buildOmpAcpSpawnInput", () => {
  it("maps T3 runtime modes to explicit OMP approval behavior", () => {
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project", "approval-required")).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode", "always-ask"],
      cwd: "/tmp/project",
    });
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project", "auto-accept-edits")).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode", "write"],
      cwd: "/tmp/project",
    });
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project", "auto")).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode", "write"],
      cwd: "/tmp/project",
    });
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project", "full-access")).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode", "yolo"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary, profile, and environment", () => {
    const environment = { OMP_TEST: "1" };
    expect(
      buildOmpAcpSpawnInput(
        { binaryPath: "/opt/omp/bin/omp", profile: "work" },
        "/tmp/project",
        "full-access",
        environment,
      ),
    ).toEqual({
      command: "/opt/omp/bin/omp",
      args: ["acp", "--profile", "work", "--approval-mode", "yolo"],
      cwd: "/tmp/project",
      env: environment,
    });
  });
});

describe("applyOmpAcpModelSelection", () => {
  it.effect("sets the exact model before applying options advertised by that model", () =>
    Effect.gen(function* () {
      const calls: Array<
        | { readonly type: "model"; readonly value: string }
        | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
      > = [];
      let configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [];
      const runtime = {
        getConfigOptions: Effect.sync(() => configOptions),
        setModel: (value: string) =>
          Effect.sync(() => {
            calls.push({ type: "model", value });
            configOptions = [
              {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: value,
                options: [{ value, name: value }],
              },
              {
                id: "thinking",
                name: "Thinking",
                category: "thought_level",
                type: "select",
                currentValue: "off",
                options: [
                  { value: "off", name: "Off" },
                  { value: "high", name: "High" },
                ],
              },
            ];
          }),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push({ type: "config", configId, value });
          }),
      };

      yield* applyOmpAcpModelSelection({
        runtime,
        model: "openai-codex/gpt-5.5",
        selections: [
          { id: "thinking", value: "high" },
          { id: "stale-option", value: true },
          { id: "model", value: "must-not-be-replayed" },
        ],
        mapError: ({ cause }) => cause.message,
      });

      expect(calls).toEqual([
        { type: "model", value: "openai-codex/gpt-5.5" },
        { type: "config", configId: "thinking", value: "high" },
      ]);
    }),
  );
});
