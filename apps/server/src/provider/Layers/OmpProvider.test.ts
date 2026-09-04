import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { OmpSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildOmpProviderSnapshot,
  buildOmpCapabilitiesFromConfigOptions,
  checkOmpProviderStatus,
  discoverOmpModelsViaAcp,
  getOmpFallbackModels,
  resolveOmpAcpConfigUpdates,
} from "./OmpProvider.ts";

const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-mock-",
  });
  const wrapperPath = path.join(dir, "fake-omp.sh");
  const mockAgentCommand = ["node", mockAgentPath].map((arg) => JSON.stringify(arg)).join(" ");
  const envExports = Object.entries({ T3_ACP_OMP_SHAPES: "1", ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${mockAgentCommand} "$@"
`;
  yield* fileSystem.writeFileString(wrapperPath, script);
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

const makeMockAgentWithVersionWrapper = Effect.fn("makeMockAgentWithVersionWrapper")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-version-mock-",
  });
  const wrapperPath = path.join(dir, "fake-omp.sh");
  const mockAgentCommand = ["node", mockAgentPath].map((arg) => JSON.stringify(arg)).join(" ");
  const script = `#!/bin/sh
export T3_ACP_OMP_SHAPES=1
if [ "$1" = "--version" ]; then
  printf 'omp/18.0.6\\n'
  exit 0
fi
exec ${mockAgentCommand} "$@"
`;
  yield* fileSystem.writeFileString(wrapperPath, script);
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

const waitForFileContent = Effect.fn("waitForFileContent")(function* (
  filePath: string,
  attempts = 40,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const content = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.catch(() => Effect.void));
    if (content !== undefined) {
      if (content.trim().length > 0) {
        return content;
      }
    }
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
});

const makeProviderStatusEnvFixture = Effect.fn("makeProviderStatusEnvFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-status-env-",
  });
  return {
    requestLogPath: path.join(tempDir, "requests.ndjson"),
    wrapperPath: yield* makeMockAgentWithVersionWrapper(),
  };
});

const makeExitLogFixture = Effect.fn("makeExitLogFixture")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix,
  });
  const exitLogPath = path.join(tempDir, "exit.log");
  return {
    exitLogPath,
    wrapperPath: yield* makeMockAgentWrapper({
      T3_ACP_EXIT_LOG_PATH: exitLogPath,
    }),
  };
});

const ompConfigOptions = [
  {
    type: "select",
    currentValue: "default",
    options: [
      { name: "Default", value: "default" },
      { name: "Plan", value: "plan" },
    ],
    category: "mode",
    id: "mode",
    name: "Mode",
  },
  {
    type: "select",
    currentValue: "zhipu-coding-plan/glm-5.3",
    options: [
      { name: "GLM 5.3", value: "zhipu-coding-plan/glm-5.3" },
      { name: "Claude Opus 4.6", value: "anthropic/claude-opus-4-6" },
      { name: "GPT-5.4", value: "openai/gpt-5.4" },
    ],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Off", value: "off" },
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Max", value: "max" },
    ],
    category: "thought_level",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const baseOmpSettings: OmpSettings = {
  enabled: true,
  binaryPath: "omp",
  customModels: [],
};
const missingOmpBinaryPath = "/definitely/not/installed/t3-omp";
const ompCliCommandMissingMessage = [
  `Oh My Pi CLI command \`${missingOmpBinaryPath}\` was not found.`,
  `Install or enable the omp CLI, make sure \`${missingOmpBinaryPath}\` is on PATH, then restart T3 Code.`,
  "See https://github.com/can1357/oh-my-pi.",
].join(" ");

describe("getOmpFallbackModels", () => {
  it("does not publish any built-in omp models before ACP discovery", () => {
    expect(
      getOmpFallbackModels({
        customModels: ["internal/omp-model"],
      }).map((model) => model.slug),
    ).toEqual(["internal/omp-model"]);
  });
});

describe("buildOmpProviderSnapshot", () => {
  it("downgrades ready status to warning when ACP model discovery times out", () => {
    expect(
      buildOmpProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        ompSettings: baseOmpSettings,
        version: "18.0.6",
        discoveryWarning: "Oh My Pi ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Oh My Pi ACP model discovery timed out after 15000ms.",
      models: [],
    });
  });

  it("preserves provider error state while appending discovery warnings", () => {
    expect(
      buildOmpProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        ompSettings: {
          ...baseOmpSettings,
          customModels: ["internal/omp-model"],
        },
        version: "18.0.6",
        status: "error",
        message: "Oh My Pi CLI is installed but failed to run.",
        discoveryWarning: "Oh My Pi ACP model discovery failed.",
      }),
    ).toMatchObject({
      status: "error",
      message: "Oh My Pi CLI is installed but failed to run. Oh My Pi ACP model discovery failed.",
      models: [
        {
          slug: "internal/omp-model",
          isCustom: true,
        },
      ],
    });
  });
});

describe("buildOmpCapabilitiesFromConfigOptions", () => {
  it("maps the omp thought_level select onto a reasoning effort descriptor", () => {
    expect(buildOmpCapabilitiesFromConfigOptions(ompConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Thinking", [
            { id: "off", label: "Off" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
          ]),
        ],
      }),
    );
  });

  it("exposes auto thinking levels on auto models", () => {
    expect(
      buildOmpCapabilitiesFromConfigOptions([
        {
          type: "select",
          currentValue: "auto",
          options: [
            { name: "Off", value: "off" },
            { name: "Auto", value: "auto" },
          ],
          category: "thought_level",
          id: "thinking",
          name: "Thinking",
        },
      ]),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Thinking", [
            { id: "off", label: "Off" },
            { id: "auto", label: "Auto", isDefault: true },
          ]),
        ],
      }),
    );
  });

  it("returns empty capabilities when no config options are advertised", () => {
    expect(buildOmpCapabilitiesFromConfigOptions([])).toEqual(
      createModelCapabilities({ optionDescriptors: [] }),
    );
    expect(buildOmpCapabilitiesFromConfigOptions(undefined)).toEqual(
      createModelCapabilities({ optionDescriptors: [] }),
    );
  });
});

describe("checkOmpProviderStatus", () => {
  it("reports the install docs when the omp CLI command is missing", async () => {
    const provider = await runNode(
      checkOmpProviderStatus({
        enabled: true,
        binaryPath: missingOmpBinaryPath,
        customModels: [],
      }),
    );

    expect(provider).toMatchObject({
      installed: false,
      status: "error",
      auth: { status: "unknown" },
      message: ompCliCommandMissingMessage,
    });
  });

  it("discovers the meta-provider catalog through ACP with the injected environment", async () => {
    const { requestLogPath, wrapperPath } = await runNode(makeProviderStatusEnvFixture());

    const provider = await runNode(
      checkOmpProviderStatus(
        {
          enabled: true,
          binaryPath: wrapperPath,
          customModels: [],
        },
        {
          ...process.env,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
      ),
    );

    expect(provider).toMatchObject({
      installed: true,
      version: "18.0.6",
      status: "ready",
      message: "3 upstream providers configured through Oh My Pi.",
    });
    expect(provider.models.map((model) => model.slug)).toEqual([
      "anthropic/claude-opus-4-6",
      "zhipu-coding-plan/glm-5.3",
      "openai/gpt-5.4",
    ]);
    expect(provider.models.map((model) => model.subProvider)).toEqual([
      "Anthropic",
      "Zhipu Coding Plan",
      "Openai",
    ]);
    await expect(runNode(waitForFileContent(requestLogPath))).resolves.toContain("initialize");
  });
});

describe("discoverOmpModelsViaAcp", () => {
  it("builds the model catalog from the ACP model config option", async () => {
    const wrapperPath = await runNode(makeMockAgentWrapper());

    const models = await runNode(
      discoverOmpModelsViaAcp({
        enabled: true,
        binaryPath: wrapperPath,
        customModels: [],
      }).pipe(Effect.scoped),
    );

    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-opus-4-6",
      "zhipu-coding-plan/glm-5.3",
      "openai/gpt-5.4",
    ]);
    expect(models[0]).toMatchObject({
      name: "Claude Opus 4.6",
      subProvider: "Anthropic",
      isCustom: false,
    });
  });

  it("closes the ACP probe runtime after discovery completes", async () => {
    const { exitLogPath, wrapperPath } = await runNode(
      makeExitLogFixture("omp-provider-exit-log-"),
    );

    await runNode(
      discoverOmpModelsViaAcp({
        enabled: true,
        binaryPath: wrapperPath,
        customModels: [],
      }),
    );

    const exitLog = await runNode(waitForFileContent(exitLogPath));
    expect(exitLog).toContain("SIGTERM");
  });
});

describe("resolveOmpAcpConfigUpdates", () => {
  it("maps reasoning selections onto the omp thinking config option", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "max" }]),
    ).toEqual([{ configId: "thinking", value: "max" }]);
  });

  it("maps reasoning off so the adapter can clear a prior thinking selection", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "off" }]),
    ).toEqual([{ configId: "thinking", value: "off" }]);
  });

  it("maps reasoning auto onto the omp thinking config option", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "auto" }]),
    ).toEqual([]);
    expect(
      resolveOmpAcpConfigUpdates(
        [
          {
            type: "select",
            currentValue: "off",
            options: [
              { name: "Off", value: "off" },
              { name: "Auto", value: "auto" },
            ],
            category: "thought_level",
            id: "thinking",
            name: "Thinking",
          },
        ],
        [{ id: "reasoning", value: "auto" }],
      ),
    ).toEqual([{ configId: "thinking", value: "auto" }]);
  });

  it("ignores unknown reasoning values and empty selections", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "ludicrous" }]),
    ).toEqual([]);
    expect(resolveOmpAcpConfigUpdates(ompConfigOptions, undefined)).toEqual([]);
    expect(resolveOmpAcpConfigUpdates([], [{ id: "reasoning", value: "max" }])).toEqual([]);
  });
});
