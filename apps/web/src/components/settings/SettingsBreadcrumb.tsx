import type { MessageKey } from "@t3tools/client-runtime/i18n";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useT } from "../../hooks/useI18n";
import { SETTINGS_SECTION_LABEL_KEYS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  ...SETTINGS_SECTION_LABEL_KEYS,
  "/settings/open-source-licenses": "settings.nav.breadcrumb.openSourceLicenses",
};

function settingsBreadcrumbLabelKey(pathname: string): MessageKey | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABEL_KEYS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const t = useT();
  const sectionLabelKey = settingsBreadcrumbLabelKey(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel={t("settings.nav.breadcrumb.a11y")}>
      {sectionLabelKey ? (
        <>
          <WorkspaceBreadcrumbItem>{t("settings.nav.breadcrumb.settings")}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabelKey ? t(sectionLabelKey) : t("settings.nav.breadcrumb.settings")}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
