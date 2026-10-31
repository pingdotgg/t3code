import { ChevronRightIcon, SettingsIcon } from "lucide-react";

import { SettingsScopePicker } from "./SettingsScopePicker";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

/** Keep the section heading accessible without repeating the visible navigation label. */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <nav aria-label="Settings breadcrumb" className="flex min-w-0 items-center gap-1.75">
      <SettingsIcon aria-hidden className="size-3.5 shrink-0 text-foreground max-sm:hidden" />
      <span className="shrink-0">Settings</span>
      <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-dim-foreground" />
      <SettingsScopePicker pathname={pathname} />
      {sectionLabel ? <h1 className="sr-only">{sectionLabel}</h1> : null}
    </nav>
  );
}
