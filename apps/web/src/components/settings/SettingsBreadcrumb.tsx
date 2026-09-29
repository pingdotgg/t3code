import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useTranslation } from "@t3tools/i18n/react";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";
import { SETTINGS_SECTION_TRANSLATION_KEYS } from "./SettingsSidebarNav";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

/**
 * `Settings / Section`. The scope a change applies to lives at the top of the
 * page content, see `SettingsScopeSentence`.
 */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const { t } = useTranslation("settings");
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const sectionKey = SETTINGS_SECTION_TRANSLATION_KEYS[normalizedPathname as SettingsPath];
  const sectionLabel =
    sectionKey !== undefined
      ? t(sectionKey)
      : normalizedPathname === "/settings/diagnostics"
        ? t("diagnostics")
        : normalizedPathname === "/settings/open-source-licenses"
          ? t("openSourceLicenses")
          : (SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null);
  const rootLabel = t("breadcrumbRoot");

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{rootLabel}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? rootLabel}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
