import { msg, useGT, useMessages } from "gt-react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { SettingsProjectSwitcher } from "./SettingsScopeSentence";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_LABEL = msg("Settings");

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": msg("Diagnostics"),
  "/settings/open-source-licenses": msg("Open source licenses"),
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  return SETTINGS_BREADCRUMB_LABELS[normalizePathname(pathname)] ?? null;
}

function normalizePathname(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const gt = useGT();
  const m = useMessages();
  const scope = useOptionalSettingsScope();
  const sectionLabel = settingsBreadcrumbLabel(pathname);
  const projectKey =
    normalizePathname(pathname) === "/settings/projects" ? scope?.search.project : undefined;

  return (
    <WorkspaceBreadcrumb ariaLabel={gt("Settings breadcrumb")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{m(SETTINGS_LABEL)}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {scope && projectKey ? (
        <>
          <WorkspaceBreadcrumbItem>
            <button
              type="button"
              onClick={() => scope.selectScope({ machine: scope.search.machine })}
              className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {m(sectionLabel ?? SETTINGS_LABEL)}
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="-ms-2">
            <SettingsProjectSwitcher />
          </WorkspaceBreadcrumbItem>
        </>
      ) : (
        <WorkspaceBreadcrumbItem current className="truncate">
          {m(sectionLabel ?? SETTINGS_LABEL)}
        </WorkspaceBreadcrumbItem>
      )}
    </WorkspaceBreadcrumb>
  );
}
