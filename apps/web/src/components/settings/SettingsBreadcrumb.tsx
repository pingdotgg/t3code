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

/** The breadcrumb opens the shared scope picker on pages with scoped settings. */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <nav
      aria-label="Settings breadcrumb"
      data-settings-breadcrumb
      className="flex min-w-0 items-center text-label"
    >
      <h1 className="flex min-w-0 items-center">
        <SettingsScopePicker pathname={pathname}>
          <span className="flex min-w-0 items-center gap-1.75 text-label">
            <SettingsIcon aria-hidden className="size-3.5 shrink-0 max-sm:hidden" />
            <span className="shrink-0">Settings</span>
            <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-dim-foreground" />
            {sectionLabel ? <span className="min-w-0 truncate">{sectionLabel}</span> : null}
          </span>
        </SettingsScopePicker>
      </h1>
    </nav>
  );
}
