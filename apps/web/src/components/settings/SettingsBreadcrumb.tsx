import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useI18n } from "../../i18n";
import type { MessageKey } from "../../i18n/messages";
import { SETTINGS_SECTION_LABEL_KEYS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  ...SETTINGS_SECTION_LABEL_KEYS,
  "/settings/diagnostics": "settings.nav.diagnostics",
};

function settingsBreadcrumbLabelKey(pathname: string): MessageKey | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABEL_KEYS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const { t } = useI18n();
  const sectionLabelKey = settingsBreadcrumbLabelKey(pathname);
  const sectionLabel = sectionLabelKey ? t(sectionLabelKey) : null;

  return (
    <WorkspaceBreadcrumb ariaLabel={t("settings.breadcrumb")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{t("settings.title")}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? t("settings.title")}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
