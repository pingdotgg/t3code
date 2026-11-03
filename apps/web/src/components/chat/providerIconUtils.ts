import { createElement, type SVGProps } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { AntigravityIcon, ClaudeAI, DevinIcon, Icon, OpenAI } from "../Icons";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";

// Cursor, Grok, Kiro, OpenCode and Pi glyphs ship with their provider packages.
const packageIcon = (driver: string): Icon | undefined => {
  const icon = providerClients.get(ProviderDriverKind.make(driver))?.icon;
  return icon
    ? (props: SVGProps<SVGSVGElement>) => createElement(ProviderPackageIcon, { icon, ...props })
    : undefined;
};

const packageIcons = Object.fromEntries(
  ["opencode", "cursor", "grok", "kiro", "pi"].flatMap((driver) => {
    const icon = packageIcon(driver);
    return icon ? [[ProviderDriverKind.make(driver), icon] as const] : [];
  }),
) as Partial<Record<ProviderDriverKind, Icon>>;

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  ...packageIcons,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("devin")]: DevinIcon,
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

export function getTriggerDisplayModelName(
  model: ModelEsque,
  driverKind: ProviderDriverKind | null | undefined,
): string {
  const shortName = resolveModelShortName(model, driverKind);
  return getDisplayModelName({ ...model, shortName }, { preferShortName: true });
}
