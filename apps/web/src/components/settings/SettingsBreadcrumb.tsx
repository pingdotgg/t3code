import { useTranslation } from "react-i18next";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABEL_KEYS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "nav.diagnostics",
  "/settings/open-source-licenses": "nav.openSourceLicenses",
};

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const { t } = useTranslation("settings");
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const labelKey = SETTINGS_BREADCRUMB_LABEL_KEYS[normalizedPathname];
  const sectionTitle = labelKey ? t(labelKey as never) : null;

  return (
    <WorkspaceBreadcrumb ariaLabel={t("aria.breadcrumb")}>
      {sectionTitle ? (
        <>
          <WorkspaceBreadcrumbItem>{t("aria.settings")}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionTitle ?? t("aria.settings")}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
