import { t } from "@palamedes/core/macro";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { getSettingsSectionLabels } from "./settingsTranslations";

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const labels: Readonly<Record<string, string>> = {
    ...getSettingsSectionLabels(),
    "/settings/open-source-licenses": t`Open source licenses`,
  };
  return labels[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel={t({ message: "Settings breadcrumb" })}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{t({ message: "Settings" })}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? t`Settings`}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
