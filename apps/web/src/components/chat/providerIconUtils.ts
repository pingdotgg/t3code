import { ProviderDriverKind } from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
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

/**
 * Leading company/brand tokens we drop from the *selected* model label so the
 * picker trigger reads "Opus 4.8" / "5.4 Codex" rather than "Claude Opus 4.8" /
 * "GPT-5.4 Codex". Only the trigger applies this; the picker list keeps the
 * full, disambiguated names.
 */
const COMPANY_PREFIX_PATTERN = /^(?:claude|gpt|openai|anthropic)[\s-]+/i;

export function stripCompanyPrefix(name: string): string {
  const stripped = name.replace(COMPANY_PREFIX_PATTERN, "").trimStart();
  return stripped.length > 0 ? stripped : name;
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  const title = getTriggerDisplayModelName(model);
  return model.subProvider ? `${model.subProvider} · ${title}` : title;
}
