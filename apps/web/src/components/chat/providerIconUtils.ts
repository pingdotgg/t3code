import { ProviderDriverKind } from "@t3tools/contracts";
import { stripLeadingModelQualifier } from "@t3tools/shared/model";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingModelQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  const modelName = getTriggerDisplayModelName(model);
  const subProvider = model.subProvider?.trim();
  return subProvider ? `${modelName} · ${subProvider}` : modelName;
}

export function getModelSourceLabel(model: ModelEsque, runtimeDisplayName: string): string {
  const subProvider = model.subProvider?.trim();
  return subProvider ? `${runtimeDisplayName} · ${subProvider}` : runtimeDisplayName;
}
