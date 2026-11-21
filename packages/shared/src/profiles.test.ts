import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { selectProfile, supportsProfiles } from "./profiles.ts";

it("applies portable provider instances, warns on fallback, and keeps explicit opt-outs", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        { slug: "haiku", name: "Haiku", isCustom: false, capabilities: { optionDescriptors: [] } },
      ],
    },
  ] satisfies Parameters<typeof selectProfile>[3];
  const current = { instanceId: ProviderInstanceId.make("codex"), model: "luna" };
  const profile = {
    prompts: [],
    skills: [],
    provider: ProviderInstanceId.make("claudeAgent-lean"),
    model: "haiku",
    effort: "low",
  };
  const fallback = selectProfile(current, "lean", profile, providers);
  assert.equal(fallback.selection.instanceId, "claudeAgent");
  assert.equal(fallback.selection.profileId, "lean");
  assert.equal(fallback.selection.model, "haiku");
  assert.deepEqual(fallback.selection.options, [{ id: "effort", value: "low" }]);
  assert.include(fallback.notice!, "claudeAgent-lean");
  const exact = selectProfile(current, "lean", profile, [
    ...providers,
    { ...providers[0]!, instanceId: profile.provider },
  ]);
  assert.equal(exact.selection.instanceId, profile.provider);
  assert.isUndefined(exact.notice);
  const unknown = selectProfile(
    current,
    "lean",
    { ...profile, provider: ProviderInstanceId.make("opaque-name") },
    providers,
  );
  assert.equal(unknown.selection.instanceId, current.instanceId);
  assert.isDefined(unknown.notice);
  assert.isNull(selectProfile(fallback.selection, null, undefined, providers).selection.profileId);
  // A default naming a profile removed from the folder must not break every new thread.
  assert.deepEqual(selectProfile(current, "removed", undefined, providers).selection, current);
  const broken = { ...profile, warning: "Could not read coding.md" };
  assert.deepEqual(selectProfile(current, "broken", broken, providers).selection, current);
  assert.isTrue(supportsProfiles("acpRegistry"));
  assert.isTrue(supportsProfiles("antigravity"));
  assert.isFalse(supportsProfiles("cursor"));
});

it("sets effort through an ACP model's own reasoning option, and skips it without one", () => {
  const thinking = {
    id: "thinking_level",
    label: "Thinking Level",
    type: "select",
    role: "reasoning",
    options: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
  } as const;
  const providers = [
    {
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      models: [
        {
          slug: "flash",
          name: "Flash",
          aliases: ["antigravity-default"],
          isCustom: false,
          capabilities: { optionDescriptors: [thinking] },
        },
      ],
    },
  ] satisfies Parameters<typeof selectProfile>[3];
  const current = {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "flash",
    options: [{ id: "thinking_level", value: "high" }],
  };
  const profile = { prompts: [], skills: [], effort: "low" };
  assert.deepEqual(selectProfile(current, "p", profile, providers).selection.options, [
    { id: "thinking_level", value: "low" },
  ]);
  assert.deepEqual(
    selectProfile({ ...current, model: "antigravity-default" }, "p", profile, providers).selection
      .options,
    [{ id: "thinking_level", value: "low" }],
  );
  const plain = [
    {
      ...providers[0]!,
      models: [{ ...providers[0]!.models[0]!, capabilities: { optionDescriptors: [] } }],
    },
  ];
  assert.deepEqual(selectProfile(current, "p", profile, plain).selection.options, current.options);
});
