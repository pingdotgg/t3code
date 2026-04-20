import { type ProviderKind, PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};

export function getProviderLabel(provider: ProviderKind, model: ModelEsque): string {
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  return model.subProvider ? `${providerLabel} · ${model.subProvider}` : providerLabel;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  if (options?.preferShortName && model.shortName) {
    return model.shortName;
  }
  return model.name;
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  const title = getTriggerDisplayModelName(model);
  return model.subProvider ? `${model.subProvider} · ${title}` : title;
}
