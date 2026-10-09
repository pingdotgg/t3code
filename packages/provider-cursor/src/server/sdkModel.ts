import type { ModelSelection as CursorSdkModelSelection, ModelParameterValue } from "@cursor/sdk";
import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

const CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION: Readonly<Record<string, string>> = {
  context: "contextWindow",
  fast: "fastMode",
};

const PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER: Readonly<Record<string, string>> = {
  contextWindow: "context",
  fastMode: "fast",
};

export function cursorSdkProviderOptionId(parameterId: string): string {
  return CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION[parameterId] ?? parameterId;
}

function cursorSdkParameterId(providerOptionId: string): string {
  return PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER[providerOptionId] ?? providerOptionId;
}

export function cursorSdkParameterPriority(parameterId: string): number {
  switch (parameterId) {
    case "effort":
    case "reasoning":
      return 0;
    case "context":
      return 1;
    case "fast":
      return 2;
    case "thinking":
      return 3;
    default:
      return 4;
  }
}

/**
 * Token capacity named by the selected `context` parameter, such as "272k" or "1m".
 * A selection without one runs on the model's default in `models`, the Cursor catalog,
 * which is unknown until that catalog has loaded.
 */
export function cursorContextWindowTokens(
  modelSelection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel>,
): number | undefined {
  const caps = models.find((model) => model.slug === modelSelection.model)?.capabilities;
  const descriptor = caps
    ? getProviderOptionDescriptors({ caps, selections: modelSelection.options }).find(
        (candidate) => candidate.id === "contextWindow",
      )
    : undefined;
  const value = descriptor
    ? getProviderOptionCurrentValue(descriptor)
    : getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const match = /^(\d+)([km])$/i.exec(typeof value === "string" ? value.trim() : "");
  if (match === null) return undefined;
  const tokens = Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

export function cursorSdkModelSelection(modelSelection: ModelSelection): CursorSdkModelSelection {
  return {
    id: modelSelection.model === "auto" ? "default" : modelSelection.model,
    ...(modelSelection.options === undefined || modelSelection.options.length === 0
      ? {}
      : {
          params: modelSelection.options.map((option): ModelParameterValue => ({
            id: cursorSdkParameterId(option.id),
            value: String(option.value),
          })),
        }),
  };
}
