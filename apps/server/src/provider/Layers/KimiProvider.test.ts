// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { KimiSettings } from "@t3tools/contracts";
import { describe, expect } from "vite-plus/test";

import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  kimiModelCapabilitiesFromConfigOptions,
} from "./KimiProvider.ts";

const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const kimiSettings = (overrides: Partial<KimiSettings> = {}): KimiSettings => ({
  enabled: true,
  binaryPath: "kimi",
  homePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

type KimiFixtureMode = "ready" | "unsupported" | "unauthenticated" | "failure";

async function makeKimiFixture(mode: KimiFixtureMode): Promise<string> {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-kimi-provider-"));
  const agentPath = NodePath.join(directory, "kimi-acp-fixture.mjs");
  const binaryPath = NodePath.join(directory, process.platform === "win32" ? "kimi.cmd" : "kimi");
  await NodeFS.writeFile(
    agentPath,
    `import * as readline from "node:readline";

const mode = process.env.T3_KIMI_FIXTURE_MODE;
let currentModel = "kimi-k2";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: [{ value: "kimi-k2", name: "Kimi K2" }, { value: "kimi-k2-thinking", name: "Kimi K2 Thinking" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  ...(currentModel === "kimi-k2-thinking"
    ? [{ id: "reasoning", name: "Reasoning", category: "model_config", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }]
    : [{ id: "thinking", name: "Thinking", category: "model_config", type: "boolean", currentValue: true }])
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
      models: {
        currentModelId: currentModel,
        availableModels: [
          { modelId: "kimi-k2", name: "Kimi K2" },
          { modelId: "kimi-k2-thinking", name: "Kimi K2 Thinking" }
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
    process.platform === "win32"
      ? `@echo off
if "%~1"=="--version" (
  echo kimi 1.2.3
  exit /b 0
)
"${process.execPath}" "${agentPath}" %*
`
      : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'kimi 1.2.3\\n'
  exit 0
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)} "$@"
`;
  await NodeFS.writeFile(binaryPath, binary, "utf8");
  await NodeFS.chmod(binaryPath, 0o755);
  return binaryPath;
}

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

describe("checkKimiProviderStatus", () => {
  it("reports a missing Kimi binary", async () => {
    const snapshot = await runNode(
      checkKimiProviderStatus(kimiSettings({ binaryPath: "/definitely/not/installed/kimi" })),
    );

    expect(snapshot.installed).toBe(false);
    expect(snapshot.message).toContain("not installed");
  });

  it("reports ACP protocol support separately from a missing binary", async () => {
    const binaryPath = await makeKimiFixture("unsupported");
    const snapshot = await runNode(
      checkKimiProviderStatus(kimiSettings({ binaryPath }), {
        ...process.env,
        T3_KIMI_FIXTURE_MODE: "unsupported",
      }),
    );

    expect(snapshot.installed).toBe(true);
    expect(snapshot.message).toContain("ACP");
  });

  it("reports authentication requirements with the Kimi login command", async () => {
    const binaryPath = await makeKimiFixture("unauthenticated");
    const snapshot = await runNode(
      checkKimiProviderStatus(kimiSettings({ binaryPath }), {
        ...process.env,
        T3_KIMI_FIXTURE_MODE: "unauthenticated",
      }),
    );

    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.message).toContain("kimi login");
  });

  it("reports unexpected ACP startup failures without treating Kimi as missing", async () => {
    const binaryPath = await makeKimiFixture("failure");
    const snapshot = await runNode(
      checkKimiProviderStatus(kimiSettings({ binaryPath }), {
        ...process.env,
        T3_KIMI_FIXTURE_MODE: "failure",
      }),
    );

    expect(snapshot.installed).toBe(true);
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.message).toContain("ACP startup failed");
  });

  it("discovers models, options, modes, and commands without prompting", async () => {
    const binaryPath = await makeKimiFixture("ready");
    const snapshot = await runNode(
      checkKimiProviderStatus(
        kimiSettings({
          binaryPath,
          customModels: ["custom-kimi", "custom-kimi", "kimi-k2"],
        }),
        { ...process.env, T3_KIMI_FIXTURE_MODE: "ready" },
      ),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.badgeLabel).toBe("Early Access");
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "kimi-k2",
      "kimi-k2-thinking",
      "custom-kimi",
    ]);
    expect(snapshot.models[0]).toMatchObject({ isDefault: true, isCustom: false });
    expect(snapshot.models[0]?.capabilities).toEqual({
      optionDescriptors: [
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
      ],
    });
    expect(snapshot.models[1]?.capabilities).toEqual({
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ],
    });
    expect(snapshot.slashCommands).toEqual([
      { name: "review", description: "Review the current change", input: { hint: "scope" } },
      { name: "ship", description: "Prepare the current change" },
    ]);
  });
});
