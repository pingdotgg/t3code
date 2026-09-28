// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { DSH_DEFAULT_MODEL, DshSettings } from "@t3tools/contracts";

import {
  buildDshModelsFromSessionConfigOptions,
  buildInitialDshProviderSnapshot,
  checkDshProviderStatus,
} from "./DshProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeDshSettings = Schema.decodeSync(DshSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");

describe("buildInitialDshProviderSnapshot", () => {
  it.effect("reports disabled providers without probing the CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDshProviderSnapshot(decodeDshSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.displayName).toBe("DSH");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toBe("DSH is disabled in T3 Code settings.");
      expect(snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot.models.map((model) => model.slug)).toEqual([DSH_DEFAULT_MODEL]);
    }),
  );

  it.effect("announces a pending CLI check while enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDshProviderSnapshot(decodeDshSettings({ enabled: true }));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toBe("Checking DSH CLI availability...");
    }),
  );
});

const modelConfigOptions = (input: {
  readonly currentValue: string;
  readonly options:
    | EffectAcpSchema.SessionConfigSelectOption[]
    | EffectAcpSchema.SessionConfigSelectGroup[];
}): EffectAcpSchema.SessionConfigOption[] => [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: input.currentValue,
    options: input.options,
  },
];

describe("buildDshModelsFromSessionConfigOptions", () => {
  it("flattens grouped options and marks the live default", () => {
    const models = buildDshModelsFromSessionConfigOptions(
      modelConfigOptions({
        currentValue: "route-b",
        options: [
          {
            group: "DeepSeek",
            name: "DeepSeek models",
            options: [
              { value: "route-a", name: "Route A" },
              { value: "route-b", name: "Route B" },
            ],
          },
        ],
      }),
    );
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["route-a", false],
      ["route-b", true],
    ]);
    expect(models[0]?.name).toBe("Route A");
  });

  it("dedupes slugs, skips blank values and falls back to the slug as name", () => {
    const models = buildDshModelsFromSessionConfigOptions(
      modelConfigOptions({
        currentValue: "",
        options: [
          { value: "route-a", name: "Route A" },
          { value: "route-a", name: "Duplicate" },
          { value: "  ", name: "Blank" },
          { value: "route-b", name: "   " },
        ],
      }),
    );
    expect(models).toEqual([
      { slug: "route-a", name: "Route A", isCustom: false, capabilities: expect.anything() },
      { slug: "route-b", name: "route-b", isCustom: false, capabilities: expect.anything() },
    ]);
  });

  it("returns no models when the model option is absent, blank, or not a select", () => {
    expect(buildDshModelsFromSessionConfigOptions(undefined)).toEqual([]);
    expect(buildDshModelsFromSessionConfigOptions(null)).toEqual([]);
    expect(
      buildDshModelsFromSessionConfigOptions([
        { id: "other", name: "Other", type: "boolean", currentValue: true },
      ]),
    ).toEqual([]);
    expect(
      buildDshModelsFromSessionConfigOptions(
        modelConfigOptions({
          currentValue: "   ",
          options: [{ value: "route-a", name: "Route A" }],
        }),
      ).map((model) => model.isDefault ?? false),
    ).toEqual([false]);
  });
});

// A stand-in for the DSH CLI: `--version` prints the bare semver and
// `--profile acp` execs the mock ACP agent so `session/new` returns a catalog.
const writeFakeDshCli = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-dsh-probe-" });
    return writeFakeCli({
      directory: dir,
      name: "dsh",
      source: [
        'if (process.argv[2] === "--version") {',
        '  process.stdout.write("0.1.7-rc.2\\n");',
        "  process.exit(0);",
        "}",
        // Early-exit style so the mock agent import stays top-level: static
        // imports inside a block would make the stub a SyntaxError.
        'if (process.argv[2] !== "--profile" || process.argv[3] !== "acp") process.exit(1);',
        execScriptSource({ scriptPath: mockAgentPath }),
        "",
      ].join("\n"),
    });
  });

it.layer(NodeServices.layer)("checkDshProviderStatus", (it) => {
  it.effect("reports disabled settings without probing the CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDshProviderStatus(decodeDshSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toBe("DSH is disabled in T3 Code settings.");
    }),
  );

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDshProviderStatus(
        decodeDshSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/dsh-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
      expect(snapshot.models.map((model) => model.slug)).toEqual([DSH_DEFAULT_MODEL]);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-dsh-version-" });
          const dshPath = writeFakeCli({
            directory: dir,
            name: "dsh",
            source: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `process.stderr.write(${JSON.stringify("broken dsh install: secret-token-value\n")});`,
              "process.exit(2);",
              "",
            ].join("\n"),
          });

          return yield* checkDshProviderStatus(
            decodeDshSettings({ enabled: true, binaryPath: dshPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("DSH CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain("secret-token-value");
    }),
  );

  it.effect("reports ready with ACP-discovered models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli();
          return yield* checkDshProviderStatus(
            decodeDshSettings({ enabled: true, binaryPath: dshPath }),
            { ...process.env },
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.1.7");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.message).toBeUndefined();
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "composer-2",
        "composer-2[fast=true]",
        "gpt-5.3-codex[reasoning=medium,fast=false]",
      ]);
      expect(snapshot.models.find((model) => model.slug === "default")?.isDefault).toBe(true);
      expect(snapshot.models.find((model) => model.slug === "composer-2")?.isDefault).toBeFalsy();
      expect(snapshot.auth).toEqual({ status: "unknown" });
      // DSH's ACP surface has no compaction command plane, so /compact must
      // not be advertised.
      expect(snapshot.slashCommands).toEqual([]);
    }),
  );

  it.effect("degrades to a warning with fallback models when the ACP probe fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-dsh-acp-fail-" });
          const dshPath = writeFakeCli({
            directory: dir,
            name: "dsh",
            source: [
              'if (process.argv[2] === "--version") {',
              '  process.stdout.write("9.9.9\\n");',
              "  process.exit(0);",
              "}",
              // The ACP probe spawn must die before initialize: no catalog.
              "process.exit(3);",
              "",
            ].join("\n"),
          });
          const envWithoutApiKey: NodeJS.ProcessEnv = { ...process.env };
          delete envWithoutApiKey.DEEPSEEK_API_KEY;
          return yield* checkDshProviderStatus(
            decodeDshSettings({ enabled: true, binaryPath: dshPath }),
            envWithoutApiKey,
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("9.9.9");
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toBe(
        "DSH CLI is installed but the ACP session probe failed. Model options may be incomplete.",
      );
      expect(snapshot.models.map((model) => model.slug)).toEqual([DSH_DEFAULT_MODEL]);
      expect(snapshot.auth).toEqual({ status: "unknown" });
    }),
  );

  it.effect("reports the DeepSeek API key when it is present in the environment", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli();
          return yield* checkDshProviderStatus(
            decodeDshSettings({ enabled: true, binaryPath: dshPath }),
            { ...process.env, DEEPSEEK_API_KEY: "sk-test" },
          );
        }),
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "DeepSeek API key",
      });
    }),
  );
});
