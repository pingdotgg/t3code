import {
  DelegationModelReferenceParts,
  type DelegationSettings,
  type ModelSelection,
  OrchestratorMcpFailure,
  type SelectProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const driverByVendor = {
  openai: "pi",
  anthropic: "claudeAgent",
  google: "antigravity",
} as const;

const parseModelReference = Schema.decodeUnknownOption(DelegationModelReferenceParts);

export const ANTIGRAVITY_SKILL_NOTICE = "skill limits not applied on Antigravity";

export const advertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

export function antigravitySuffixedModel(provider: ServerProvider, model: string) {
  if (provider.driver !== "antigravity" || advertisedModel(provider, model)) return;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return;
  const family = model.slice(0, separator);
  const value = model.slice(separator + 1);
  const thinking = provider.models
    .find((candidate) => candidate.slug === family)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
  if (thinking?.type === "select" && thinking.options.some((choice) => choice.id === value)) {
    return { model: family, thinking: { id: thinking.id, value } };
  }
}

export function resolveDelegationRoute(
  providerByVendor: DelegationSettings["providerByVendor"],
  model: string,
) {
  const reference = parseModelReference(model);
  if (reference._tag === "None") {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: "Profile models must use openai:<model>, anthropic:<model> or google:<model>.",
      }),
    );
  }
  const [vendor, , nativeModel] = reference.value;
  return Effect.succeed({
    vendor,
    model: nativeModel,
    driver: driverByVendor[vendor],
    instanceId: providerByVendor[vendor] ?? null,
  });
}

export const resolveDelegationModel = Effect.fn("resolveDelegationModel")(function* (input: {
  readonly provider: ServerProvider;
  readonly model: string;
  readonly profile: DelegationSettings["profiles"][string];
}): Effect.fn.Return<ModelSelection, OrchestratorMcpFailure> {
  const { provider, profile } = input;
  const legacy = antigravitySuffixedModel(provider, input.model);
  const model = legacy?.model ?? input.model;
  const advertised = advertisedModel(provider, model);
  if (advertised === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "model_unavailable",
      message: `Model ${model} is not advertised by provider ${provider.instanceId}. Use orchestrator_capabilities with search to find models.`,
    });
  }
  const desired = profile.options?.thinking;
  let thinking = legacy?.thinking;
  if (desired !== undefined) {
    const descriptors = advertised.capabilities?.optionDescriptors;
    const reasoning = descriptors?.find(
      (option): option is SelectProviderOptionDescriptor =>
        option.type === "select" &&
        (provider.driver === "pi"
          ? option.id === "thinking"
          : provider.driver === "claudeAgent"
            ? option.id === "effort"
            : option.role === "reasoning"),
    );
    const advertisedSuffix = advertised.slug.slice(advertised.slug.lastIndexOf("-") + 1);
    const embeddedLevel =
      legacy?.thinking.value ??
      (provider.driver === "antigravity" &&
      reasoning?.options.some((option) => option.id === advertisedSuffix)
        ? advertisedSuffix
        : undefined);
    if (embeddedLevel !== undefined && embeddedLevel !== desired) {
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `Model ${input.model} specifies thinking ${embeddedLevel}, which conflicts with profile thinking ${desired}.`,
      });
    }
    if (!reasoning?.options.some((option) => option.id === desired)) {
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `Model ${model} on ${provider.instanceId} does not advertise thinking ${desired}.`,
      });
    }
    thinking = { id: reasoning.id, value: desired };
  }

  return {
    instanceId: provider.instanceId,
    model,
    ...(thinking === undefined ? {} : { options: [thinking] }),
  };
});
