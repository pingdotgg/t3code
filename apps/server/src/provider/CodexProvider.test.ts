import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  codexAppServerEnvironment,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

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

const PROXY = "http://proxy.corp.example:8080";
const LOOPBACK = "127.0.0.1,localhost,::1";
const BLANK_SHELL_NO_PROXY = [
  "-c",
  'shell_environment_policy.set.NO_PROXY=""',
  "-c",
  'shell_environment_policy.set.no_proxy=""',
];

it.each([
  {
    name: "extends each spelling the user set with only its own hosts",
    platform: "linux",
    environment: { HTTP_PROXY: PROXY, NO_PROXY: "intranet.example", no_proxy: "remote.example" },
    expected: { NO_PROXY: `intranet.example,${LOOPBACK}`, no_proxy: `remote.example,${LOOPBACK}` },
    configArgs: [],
  },
  {
    name: "does not create NO_PROXY, which would shadow the user's no_proxy",
    platform: "darwin",
    environment: { no_proxy: "remote.example" },
    expected: { NO_PROXY: undefined, no_proxy: `remote.example,${LOOPBACK}` },
    configArgs: [],
  },
  {
    name: "keeps a wildcard as the user wrote it",
    platform: "linux",
    environment: { HTTPS_PROXY: PROXY, NO_PROXY: "*" },
    expected: { NO_PROXY: "*", no_proxy: undefined },
    configArgs: [],
  },
  {
    name: "extends an empty NO_PROXY, which Codex reads before no_proxy",
    platform: "linux",
    environment: { HTTP_PROXY: PROXY, NO_PROXY: "", no_proxy: "intranet.example" },
    expected: { NO_PROXY: LOOPBACK, no_proxy: `intranet.example,${LOOPBACK}` },
    configArgs: [],
  },
  {
    name: "creates both spellings when Codex already uses env proxies",
    platform: "linux",
    environment: { https_proxy: PROXY },
    expected: { NO_PROXY: LOOPBACK, no_proxy: LOOPBACK },
    configArgs: [],
  },
  {
    name: "keeps the Windows registry bypass list in charge alongside env proxies",
    platform: "win32",
    environment: { https_proxy: PROXY },
    expected: { NO_PROXY: undefined, no_proxy: undefined },
    configArgs: [],
  },
  {
    name: "extends a Windows NO_PROXY the user already set",
    platform: "win32",
    environment: { https_proxy: PROXY, NO_PROXY: "intranet.example" },
    expected: { NO_PROXY: `intranet.example,${LOOPBACK}`, no_proxy: undefined },
    configArgs: [],
  },
  {
    name: "exempts loopback from a macOS system proxy without reaching agent shells",
    platform: "darwin",
    environment: {},
    expected: { NO_PROXY: LOOPBACK, no_proxy: LOOPBACK },
    configArgs: BLANK_SHELL_NO_PROXY,
  },
  {
    name: "leaves Linux without env proxies unchanged",
    platform: "linux",
    environment: { NO_PROXY: "" },
    expected: { NO_PROXY: "", no_proxy: undefined },
    configArgs: [],
  },
] satisfies ReadonlyArray<{
  name: string;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  expected: { NO_PROXY: string | undefined; no_proxy: string | undefined };
  configArgs: ReadonlyArray<string>;
}>)("$name", ({ platform, environment, expected, configArgs }) => {
  const launch = codexAppServerEnvironment(environment, platform);

  assert.deepStrictEqual(
    { NO_PROXY: launch.env.NO_PROXY, no_proxy: launch.env.no_proxy },
    expected,
  );
  assert.deepStrictEqual(launch.configArgs, configArgs);
});
