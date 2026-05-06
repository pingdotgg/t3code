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

export type OpenCodeModelLane = "go" | "zen";

const OPENCODE_DRIVER_KIND = ProviderDriverKind.make("opencode");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}

export function getOpenCodeModelLane(
  model: Pick<ModelEsque, "slug" | "subProvider">,
): OpenCodeModelLane {
  const providerId = model.slug.split("/", 1)[0] ?? "";
  const source = `${model.subProvider ?? ""} ${providerId}`.toLowerCase();
  return /(^|[^a-z0-9])zen([^a-z0-9]|$)/u.test(source) ? "zen" : "go";
}

export function getModelProviderDisplayName(
  driverKind: ProviderDriverKind,
  providerDisplayName: string,
  model: ModelEsque,
): string {
  if (driverKind === OPENCODE_DRIVER_KIND) {
    return getOpenCodeModelLane(model) === "zen" ? "OpenCode Zen" : "OpenCode Go";
  }
  return model.subProvider ? `${providerDisplayName} · ${model.subProvider}` : providerDisplayName;
}
