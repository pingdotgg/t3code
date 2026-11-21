import type { ModelSelection, ProfileCatalog, ServerProvider } from "@t3tools/contracts";

const EFFORT_OPTION_IDS: Partial<Record<string, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
  muse: "reasoningEffort",
  pi: "thinking",
};

export function supportsProfiles(driver: string): boolean {
  return ["claudeAgent", "codex", "muse", "pi", "acpRegistry", "antigravity"].includes(driver);
}

export function selectProfile(
  current: ModelSelection,
  id: string | null,
  profile: ProfileCatalog["profiles"][string] | undefined,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "models">>,
): { selection: ModelSelection; notice?: string } {
  if (id === null) return { selection: { ...current, profileId: null } };
  if (profile === undefined || profile.warning) return { selection: current };
  const named = profile.provider;
  const exact = providers.find((provider) => provider.instanceId === named);
  // Portable instance ids use the driver's id as a prefix, e.g. claudeAgent-lean.
  const fallback =
    named && !exact
      ? providers.find(
          (provider) =>
            String(provider.instanceId) === String(provider.driver) &&
            (named.startsWith(`${provider.driver}-`) || named.startsWith(`${provider.driver}_`)),
        )
      : undefined;
  const provider = exact ?? fallback;
  const instanceId = provider?.instanceId ?? current.instanceId;
  const model =
    profile.model ??
    (instanceId === current.instanceId
      ? current.model
      : (provider?.models[0]?.slug ?? current.model));
  const target = provider ?? providers.find((entry) => entry.instanceId === instanceId);
  // ACP agents name their reasoning control themselves, such as Antigravity's `thinking_level`.
  const reasoning = target?.models
    .find((entry) => entry.slug === model || entry.aliases?.includes(model))
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
  const effortId = reasoning?.id ?? (target ? EFFORT_OPTION_IDS[target.driver] : undefined);
  const options = instanceId === current.instanceId ? (current.options ?? []) : [];
  return {
    selection: {
      ...current,
      profileId: id,
      instanceId,
      model,
      options,
      ...(profile.effort && effortId
        ? {
            options: [
              ...options.filter((option) => option.id !== effortId),
              { id: effortId, value: profile.effort },
            ],
          }
        : {}),
    },
    ...(named && !exact
      ? {
          notice: `Provider ${named} is not installed here. Using ${instanceId}; check the model before sending.`,
        }
      : {}),
  };
}
