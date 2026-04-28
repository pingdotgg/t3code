import type { ComponentType } from "react";
import {
  IconBubbleLeftAndTextBubbleRight as ThreadsIcon,
  IconMessage as ProvidersIcon,
  IconTheatermaskAndPaintbrushFill as InterfaceIcon,
  IconWrenchAndScrewdriver as AdvancedIcon,
} from "symbols-react";
import { Link2Icon } from "lucide-react";

export type SettingsRestoreScope = "interface" | "threads" | "providers";

export type SettingsSectionPath =
  | "/settings/interface"
  | "/settings/threads"
  | "/settings/providers"
  | "/settings/connections"
  | "/settings/advanced";

export const SETTINGS_DEFAULT_PATH: SettingsSectionPath = "/settings/interface";

export const LEGACY_SETTINGS_PATH_REDIRECTS = {
  "/settings/general": "/settings/interface",
  "/settings/archived": "/settings/threads",
} as const;

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
  iconUsesFill: boolean;
  restoreScope: SettingsRestoreScope | null;
}> = [
  {
    label: "Interface",
    to: "/settings/interface",
    icon: InterfaceIcon,
    iconUsesFill: true,
    restoreScope: "interface",
  },
  {
    label: "Threads",
    to: "/settings/threads",
    icon: ThreadsIcon,
    iconUsesFill: true,
    restoreScope: "threads",
  },
  {
    label: "Providers",
    to: "/settings/providers",
    icon: ProvidersIcon,
    iconUsesFill: true,
    restoreScope: "providers",
  },
  {
    label: "Connections",
    to: "/settings/connections",
    icon: Link2Icon,
    iconUsesFill: false,
    restoreScope: null,
  },
  {
    label: "Advanced",
    to: "/settings/advanced",
    icon: AdvancedIcon,
    iconUsesFill: true,
    restoreScope: null,
  },
] as const;

export function resolveSettingsPathname(pathname: string): SettingsSectionPath | null {
  const canonicalPathname =
    pathname in LEGACY_SETTINGS_PATH_REDIRECTS
      ? LEGACY_SETTINGS_PATH_REDIRECTS[pathname as keyof typeof LEGACY_SETTINGS_PATH_REDIRECTS]
      : pathname;

  return SETTINGS_NAV_ITEMS.find((item) => item.to === canonicalPathname)?.to ?? null;
}

export function getSettingsRestoreScope(pathname: string): SettingsRestoreScope | null {
  const currentPath = resolveSettingsPathname(pathname);
  return SETTINGS_NAV_ITEMS.find((item) => item.to === currentPath)?.restoreScope ?? null;
}
