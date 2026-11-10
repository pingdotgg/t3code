import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  probeCodexSkillsForCwd,
} from "./CodexProvider.ts";

// The mock app-server is a shell script Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const makeRemotePluginCodexFixture = Effect.fn("CodexProvider.test.makeRemotePluginCodexFixture")(
  function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skills-" });
    const sourceDir = path.join(import.meta.dirname, "testFixtures");
    const binaryPath = path.join(fixtureDir, "codex");
    const scriptPath = path.join(fixtureDir, "codex-script.json");
    yield* fileSystem.copyFile(path.join(sourceDir, "codexCollabMockPeer.sh"), binaryPath);
    yield* fileSystem.chmod(binaryPath, 0o755);
    for (const file of ["codexCollabMockPeer.mjs", "codexMultiAgentWire.json"]) {
      yield* fileSystem.copyFile(path.join(sourceDir, file), path.join(fixtureDir, file));
    }
    yield* fileSystem.writeFileString(
      scriptPath,
      JSON.stringify({
        rootThreadId: "probe-thread",
        notifications: [],
        remoteInstalledPluginSkills: [
          {
            name: "impeccable:impeccable",
            description: "Design review skill",
            path: path.join(fixtureDir, "impeccable", "SKILL.md"),
            enabled: true,
            scope: "user",
            pluginId: "impeccable@openai-curated-remote",
          },
        ],
      }),
    );
    return {
      binaryPath,
      cwd: fixtureDir,
      environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
    };
  },
);

it.live.skipIf(windowsHost)("lists remote marketplace plugin skills for a workspace", () =>
  Effect.gen(function* () {
    const fixture = yield* makeRemotePluginCodexFixture();
    const skills = yield* probeCodexSkillsForCwd(fixture);

    assert.deepStrictEqual(
      skills.map((skill) => skill.name),
      ["impeccable:impeccable"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
