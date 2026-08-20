import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";

import { applyKimiAcpModelSelection, buildKimiAcpSpawnInput } from "./KimiAcpSupport.ts";

describe("buildKimiAcpSpawnInput", () => {
  it.each([null, undefined])("uses the default Kimi ACP command for %s settings", (settings) => {
    expect(buildKimiAcpSpawnInput(settings, "/repo")).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/repo",
    });
  });

  it("puts tokenized global launch arguments before the Kimi ACP subcommand", () => {
    expect(
      buildKimiAcpSpawnInput(
        { binaryPath: "/opt/kimi", launchArgs: "--agent coder --skills-dir 'team skills'" },
        "/repo",
        { KIMI_CODE_HOME: "/homes/work" },
      ),
    ).toEqual({
      command: "/opt/kimi",
      args: ["--agent", "coder", "--skills-dir", "team skills", "acp"],
      cwd: "/repo",
      env: { KIMI_CODE_HOME: "/homes/work" },
    });
  });
});

describe("applyKimiAcpModelSelection", () => {
  it.effect(
    "sets the requested model before applying only compatible advertised option selections",
    () =>
      Effect.gen(function* () {
        const calls: Array<
          | { readonly type: "model"; readonly value: string }
          | { readonly type: "config"; readonly id: string; readonly value: string | boolean }
        > = [];
        const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
          {
            id: "reasoning",
            name: "Reasoning",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "auto-approve",
            name: "Auto approve",
            type: "boolean",
            currentValue: false,
          },
        ];
        const runtime = {
          getConfigOptions: Effect.sync(() => configOptions),
          setModel: (value: string) =>
            Effect.sync(() => {
              calls.push({ type: "model", value });
            }),
          setConfigOption: (id: string, value: string | boolean) =>
            Effect.sync(() => {
              calls.push({ type: "config", id, value });
            }),
        };

        yield* applyKimiAcpModelSelection({
          runtime,
          model: "kimi-k2",
          selections: [
            { id: "reasoning", value: "high" },
            { id: "auto-approve", value: true },
            { id: "missing", value: "ignored" },
            { id: "reasoning", value: true },
            { id: "auto-approve", value: "true" },
          ],
        });

        expect(calls).toEqual([
          { type: "model", value: "kimi-k2" },
          { type: "config", id: "reasoning", value: "high" },
          { type: "config", id: "auto-approve", value: true },
        ]);
      }),
  );

  it.effect(
    "skips stale flat and grouped select values while applying later advertised values",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly id: string; readonly value: string | boolean }> = [];
        const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
          {
            id: "effort",
            name: "Effort",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "region",
            name: "Region",
            type: "select",
            currentValue: "us-east",
            options: [
              {
                group: "North America",
                name: "North America",
                options: [
                  { value: "us-east", name: "US East" },
                  { value: "us-west", name: "US West" },
                ],
              },
            ],
          },
        ];
        const runtime = {
          getConfigOptions: Effect.succeed(configOptions),
          setModel: () => Effect.void,
          setConfigOption: (id: string, value: string | boolean) =>
            Effect.sync(() => {
              calls.push({ id, value });
            }),
        };

        yield* applyKimiAcpModelSelection({
          runtime,
          model: undefined,
          selections: [
            { id: "effort", value: "stale" },
            { id: "effort", value: "high" },
            { id: "region", value: "moon-base" },
            { id: "region", value: "us-west" },
          ],
        });

        expect(calls).toEqual([
          { id: "effort", value: "high" },
          { id: "region", value: "us-west" },
        ]);
      }),
  );
});
