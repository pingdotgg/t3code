// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildDevinCapabilitiesFromConfigOptions,
  buildDevinProviderSnapshot,
  checkDevinProviderStatus,
  parseDevinAuthStatus,
  resolveDevinAcpConfigUpdates,
  resolveDevinAcpModelId,
} from "./DevinProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_AUTH_OUTPUT = [
  "Logged in (via Devin).",
  "",
  "Credentials:",
  "  File: /home/user/.local/share/devin/credentials.toml",
  "",
  "User:",
  "  Name:  Test User",
  "  Email: devin-test@example.com",
  "",
  "Account:",
  "  Tier: Devin Pro",
  "",
].join("\n");

const LOGGED_OUT_AUTH_OUTPUT = [
  "Not logged in.",
  "",
  "Credentials path: /home/user/.local/share/devin/credentials.toml",
  "",
  "Run `devin auth login` to authenticate.",
  "",
].join("\n");

const DEVIN_CONFIG_OPTIONS: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "adaptive",
    options: [
      { value: "adaptive", name: "Adaptive" },
      { value: "swe-2-max", name: "SWE-2 Max" },
    ],
  },
  {
    id: "thought_level",
    name: "Thought level",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

describe("parseDevinAuthStatus", () => {
  it("reads the signed-in account from `devin auth status`", () => {
    const parsed = parseDevinAuthStatus({
      stdout: LOGGED_IN_AUTH_OUTPUT,
      stderr: "",
      code: 0,
    });
    expect(parsed.auth).toEqual({
      status: "authenticated",
      email: "devin-test@example.com",
      type: "devin_pro",
      label: "Devin Pro",
    });
    expect(parsed.message).toBeUndefined();
  });

  it("reports logged-out output as unauthenticated with a login hint", () => {
    const parsed = parseDevinAuthStatus({
      stdout: "",
      stderr: LOGGED_OUT_AUTH_OUTPUT,
      code: 0,
    });
    expect(parsed.auth.status).toBe("unauthenticated");
    expect(parsed.message).toContain("devin auth login");
  });

  it("reports unknown auth for unrecognized output", () => {
    const parsed = parseDevinAuthStatus({
      stdout: "devin 3000.11.3\n",
      stderr: "",
      code: 1,
    });
    expect(parsed.auth.status).toBe("unknown");
    expect(parsed.message).toBeDefined();
  });
});

describe("resolveDevinAcpModelId", () => {
  it("keeps model ids verbatim and falls back to adaptive", () => {
    expect(resolveDevinAcpModelId("swe-2-max")).toBe("swe-2-max");
    expect(resolveDevinAcpModelId("  fusion-claude-fable-5-1-medium-sidekick-swe-2-medium  ")).toBe(
      "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
    );
    expect(resolveDevinAcpModelId(undefined)).toBe("adaptive");
    expect(resolveDevinAcpModelId("   ")).toBe("adaptive");
  });
});

describe("buildDevinCapabilitiesFromConfigOptions", () => {
  it("exposes thought_level as the reasoning option descriptor", () => {
    const capabilities = buildDevinCapabilitiesFromConfigOptions(DEVIN_CONFIG_OPTIONS);
    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoning",
        label: "Thought level",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
        ],
        currentValue: "high",
      },
    ]);
  });

  it("returns empty capabilities when Devin omits thought_level", () => {
    expect(buildDevinCapabilitiesFromConfigOptions(DEVIN_CONFIG_OPTIONS.slice(0, 1))).toEqual({
      optionDescriptors: [],
    });
  });
});

describe("resolveDevinAcpConfigUpdates", () => {
  it("maps a reasoning selection onto the thought_level option", () => {
    expect(
      resolveDevinAcpConfigUpdates(DEVIN_CONFIG_OPTIONS, [{ id: "reasoning", value: "max" }]),
    ).toEqual([{ configId: "thought_level", value: "max" }]);
  });

  it("drops selections that are not Devin thought levels", () => {
    expect(
      resolveDevinAcpConfigUpdates(DEVIN_CONFIG_OPTIONS, [
        { id: "reasoning", value: "not-a-level" },
      ]),
    ).toEqual([]);
  });
});

// A stand-in for the Devin CLI: `--version` and `auth status` print canned
// text, and `acp` execs the mock ACP agent in its Devin profile so the probe
// session returns the Devin config-option catalog.
const writeFakeDevinCli = (input: { readonly authOutput: string; readonly acp: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-probe-" });
    const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
    return writeFakeCli({
      directory: dir,
      name: "devin",
      env: input.acp ? { T3_ACP_DEVIN: "1" } : {},
      source: [
        'if (process.argv[2] === "--version") {',
        '  process.stdout.write("devin 3000.11.3 (9c803229faa4)\\n");',
        "  process.exit(0);",
        "}",
        'if (process.argv[2] === "auth" && process.argv[3] === "status") {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `  process.stdout.write(${JSON.stringify(input.authOutput)});`,
        "  process.exit(0);",
        "}",
        'if (process.argv[2] !== "acp") process.exit(1);',
        ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
        "",
      ].join("\n"),
    });
  });

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("/definitely/not/installed/devin-binary");
      expect(snapshot.message).toContain("devin");
    }),
  );

  it.effect("reports unauthenticated from `devin auth status` without probing ACP", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_OUT_AUTH_OUTPUT,
            acp: false,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBe("3000.11.3");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("devin auth login");
      // The adaptive fallback stays visible so the picker never goes empty.
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
    }),
  );

  it.effect("reports ready with ACP-discovered models when logged in", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_AUTH_OUTPUT,
            acp: true,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("3000.11.3");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        email: "devin-test@example.com",
        type: "devin_pro",
        label: "Devin Pro",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "adaptive",
        "swe-2-high",
        "swe-2-max",
        "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
      ]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
      expect(
        snapshot.models[0]?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
      ).toEqual(["reasoning"]);
    }),
  );

  it.effect("surfaces a warning when ACP discovery fails but auth is fine", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_AUTH_OUTPUT,
            acp: false,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.message).toContain("Devin ACP model discovery failed");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["adaptive"]);
    }),
  );

  it.effect("appends custom models after the discovered catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_AUTH_OUTPUT,
            acp: true,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({
              enabled: true,
              binaryPath: devinPath,
              customModels: [{ slug: "my-custom-model", name: "Mine" }],
            }),
          );
        }),
      );

      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "adaptive",
        "swe-2-high",
        "swe-2-max",
        "fusion-claude-fable-5-1-medium-sidekick-swe-2-medium",
        "my-custom-model",
      ]);
      expect(snapshot.models[4]?.isCustom).toBe(true);
    }),
  );
});

describe("buildDevinProviderSnapshot", () => {
  it("marks the session's current model as default", () => {
    const snapshot = buildDevinProviderSnapshot({
      checkedAt: "2026-01-01T00:00:00.000Z",
      devinSettings: decodeDevinSettings({ enabled: true }),
      parsed: { version: "3000.11.3", status: "ready", auth: { status: "authenticated" } },
      discoveredModels: [
        {
          slug: "adaptive",
          name: "Adaptive",
          isCustom: false,
          capabilities: buildDevinCapabilitiesFromConfigOptions(DEVIN_CONFIG_OPTIONS),
        },
        {
          slug: "swe-2-max",
          name: "SWE-2 Max",
          isCustom: false,
          isDefault: true,
          capabilities: buildDevinCapabilitiesFromConfigOptions(DEVIN_CONFIG_OPTIONS),
        },
      ],
    });
    expect(snapshot.models.map((model) => model.isDefault ?? false)).toEqual([false, true]);
    expect(snapshot.slashCommands?.map((command) => command.name)).toEqual(["compact"]);
  });
});
