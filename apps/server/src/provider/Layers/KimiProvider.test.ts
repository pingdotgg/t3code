// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { KimiSettings } from "@t3tools/contracts";
import { describe, expect } from "vite-plus/test";

import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  kimiModelCapabilitiesFromConfigOptions,
  kimiModelStateFromSessionSetup,
} from "./KimiProvider.ts";

const withNodeServices = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
) => effect.pipe(Effect.provide(NodeServices.layer));
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const kimiSettings = (overrides: Partial<KimiSettings> = {}): KimiSettings => ({
  enabled: true,
  binaryPath: "kimi",
  homePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

type KimiFixtureMode = "ready" | "unsupported" | "unauthenticated" | "failure";

const makeKimiFixture = Effect.fn("makeKimiFixture")(function* (
  mode: KimiFixtureMode,
  version = "1.2.3",
) {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.promise(async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-kimi-provider-"));
    const agentPath = NodePath.join(directory, "kimi-acp-fixture.mjs");
    const binaryPath = NodePath.join(directory, platform === "win32" ? "kimi.cmd" : "kimi");
    await NodeFSP.writeFile(
      agentPath,
      `import * as readline from "node:readline";

const mode = process.env.T3_KIMI_FIXTURE_MODE;
let currentModel = "kimi-code/kimi-for-coding";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: [{ value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" }, { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" }, { value: "kimi-code/k3", name: "K3" }, { value: "kimi-code/k3-256k", name: "K3-256k" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  ...(currentModel === "kimi-code/k3" || currentModel === "kimi-code/k3-256k"
    ? [{ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] }]
    : [{ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "on", options: [{ value: "on", name: "On" }] }])
];

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (mode === "unsupported") fail(request.id, -32601, "ACP protocol is not supported");
    else reply(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    continue;
  }
  if (request.method === "authenticate") {
    if (mode === "unauthenticated") fail(request.id, -32000, "Kimi login required");
    else reply(request.id, {});
    continue;
  }
  if (request.method === "session/new") {
    if (mode === "failure") process.exit(7);
    reply(request.id, {
      sessionId: "kimi-fixture-session",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" }
        ]
      },
      configOptions: configOptions()
    });
    notify("session/update", {
      sessionId: "kimi-fixture-session",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review the current change", input: { hint: "scope" } },
          { name: "ship", description: "Prepare the current change" }
        ]
      }
    });
    continue;
  }
  if (request.method === "session/set_config_option") {
    if (request.params.configId === "model") currentModel = request.params.value;
    reply(request.id, { configOptions: configOptions() });
    continue;
  }
}
`,
      "utf8",
    );
    const binary =
      platform === "win32"
        ? `@echo off
if "%~1"=="--version" (
  echo kimi ${version}
  exit /b 0
)
"${process.execPath}" "${agentPath}" %*
`
        : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'kimi ${version}\\n'
  exit 0
fi
exec ${encodeJsonString(process.execPath)} ${encodeJsonString(agentPath)} "$@"
`;
    await NodeFSP.writeFile(binaryPath, binary, "utf8");
    await NodeFSP.chmod(binaryPath, 0o755);
    return binaryPath;
  });
});

describe("buildInitialKimiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when Kimi is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(kimiSettings({ enabled: false }));
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
    }),
  );
});

describe("kimiModelCapabilitiesFromConfigOptions", () => {
  it("keeps advertised Kimi option ids and excludes model and mode selectors", () => {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "kimi-k2",
        options: [{ value: "kimi-k2", name: "Kimi K2" }],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "model_config",
        type: "boolean",
        currentValue: true,
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    expect(kimiModelCapabilitiesFromConfigOptions(configOptions)).toEqual({
      optionDescriptors: [
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
      ],
    });
  });
});

describe("kimiModelStateFromSessionSetup", () => {
  it("uses the generic ACP model option and ignores blank and duplicate entries", () => {
    expect(
      kimiModelStateFromSessionSetup({
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "kimi-code/k3",
            options: [
              { value: "", name: "Blank" },
              { value: "kimi-code/k3", name: "K3" },
              { value: "kimi-code/k3", name: "Duplicate" },
            ],
          },
        ],
      }),
    ).toEqual({
      currentModelId: "kimi-code/k3",
      availableModels: [{ modelId: "kimi-code/k3", name: "K3" }],
    });
  });

  it("falls back to legacy ACP model state when no model option is advertised", () => {
    const models = {
      currentModelId: "kimi-k2",
      availableModels: [
        { modelId: "kimi-k2", name: "Kimi K2" },
        { modelId: "kimi-k2-thinking", name: "Kimi K2 Thinking" },
      ],
    } satisfies EffectAcpSchema.SessionModelState;

    expect(kimiModelStateFromSessionSetup({ models })).toEqual({
      currentModelId: "kimi-k2",
      availableModels: models.availableModels,
    });
  });

  it("falls back to legacy ACP model state when the model option has no usable values", () => {
    const models = {
      currentModelId: "kimi-k2",
      availableModels: [{ modelId: "kimi-k2", name: "Kimi K2" }],
    } satisfies EffectAcpSchema.SessionModelState;

    expect(
      kimiModelStateFromSessionSetup({
        models,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "",
            options: [{ value: " ", name: "Blank" }],
          },
        ],
      }),
    ).toEqual({
      currentModelId: "kimi-k2",
      availableModels: models.availableModels,
    });
  });
});

describe("checkKimiProviderStatus", () => {
  it.effect("reports a missing Kimi binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(kimiSettings({ binaryPath: "/definitely/not/installed/kimi" })),
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("not installed");
    }),
  );

  it.effect("reports ACP protocol support separately from a missing binary", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeKimiFixture("unsupported");
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(kimiSettings({ binaryPath }), {
          ...process.env,
          T3_KIMI_FIXTURE_MODE: "unsupported",
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toContain("ACP");
    }),
  );

  it.effect("rejects Kimi versions that cannot expose selectable thinking levels", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeKimiFixture("ready", "0.28.1");
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(kimiSettings({ binaryPath }), {
          ...process.env,
          T3_KIMI_FIXTURE_MODE: "ready",
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBe("0.28.1");
      expect(snapshot.message).toContain("0.29.0");
      expect(snapshot.message).toContain("thinking levels");
    }),
  );

  it.effect("rejects prereleases older than the minimum stable Kimi version", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeKimiFixture("ready", "0.29.0-beta.1");
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(kimiSettings({ binaryPath }), {
          ...process.env,
          T3_KIMI_FIXTURE_MODE: "ready",
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBe("0.29.0-beta.1");
    }),
  );

  it.effect("rejects Kimi output whose version cannot be verified", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeKimiFixture("ready", "unknown");
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(kimiSettings({ binaryPath }), {
          ...process.env,
          T3_KIMI_FIXTURE_MODE: "ready",
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Unable to determine Kimi version");
      expect(snapshot.message).toContain("0.29.0");
    }),
  );

  it.effect("reports authentication requirements with the Kimi login command", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeKimiFixture("unauthenticated");
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(kimiSettings({ binaryPath }), {
          ...process.env,
          T3_KIMI_FIXTURE_MODE: "unauthenticated",
        }),
      );

      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kimi login");
    }),
  );

  it.effect("reports unexpected ACP startup failures without treating Kimi as missing", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeKimiFixture("failure");
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(kimiSettings({ binaryPath }), {
          ...process.env,
          T3_KIMI_FIXTURE_MODE: "failure",
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("discovers models, options, modes, and commands without prompting", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeKimiFixture("ready", "0.29.0");
      const snapshot = yield* withNodeServices(
        checkKimiProviderStatus(
          kimiSettings({
            binaryPath,
            customModels: ["custom-kimi", "custom-kimi", "kimi-code/k3"],
          }),
          { ...process.env, T3_KIMI_FIXTURE_MODE: "ready" },
        ),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "kimi-code/kimi-for-coding",
        "kimi-code/kimi-for-coding-highspeed",
        "kimi-code/k3",
        "kimi-code/k3-256k",
        "custom-kimi",
      ]);
      expect(snapshot.models[0]).toMatchObject({ isDefault: true, isCustom: false });
      expect(snapshot.models[0]?.capabilities).toEqual({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            currentValue: "on",
            options: [{ id: "on", label: "On", isDefault: true }],
          },
        ],
      });
      expect(snapshot.models[1]).toMatchObject({
        slug: "kimi-code/kimi-for-coding-highspeed",
        name: "K2.7 Coding Highspeed",
        isCustom: false,
      });
      expect(snapshot.models[2]?.capabilities).toEqual({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            currentValue: "high",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      });
      expect(snapshot.slashCommands).toEqual([
        { name: "review", description: "Review the current change", input: { hint: "scope" } },
        { name: "ship", description: "Prepare the current change" },
      ]);
    }),
  );
});
