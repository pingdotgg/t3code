import { type ProviderInstanceId } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpRegistryAdapterOptions } from "../AcpRegistryAdapterLayer.ts";
import { collectSessionConfigOptionValues } from "../../acp/AcpRuntimeModel.ts";

export const resolveSelectedAcpModel = (
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modelSelection: { readonly instanceId?: ProviderInstanceId; readonly model?: string } | undefined,
  options: AcpRegistryAdapterOptions,
): string | undefined => {
  if (modelSelection?.instanceId !== options.instanceId) {
    return undefined;
  }
  const selectedModel = modelSelection.model?.trim();
  if (!selectedModel) {
    return undefined;
  }
  const modelConfigOption = configOptions.find(
    (option) => (option.category === "model" || option.id === "model") && option.type === "select",
  );
  if (!modelConfigOption) {
    return undefined;
  }
  return collectSessionConfigOptionValues(modelConfigOption).includes(selectedModel)
    ? selectedModel
    : undefined;
};
