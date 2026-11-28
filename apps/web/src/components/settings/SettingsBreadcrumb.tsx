import { msg, useGT, useMessages } from "gt-react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { ALL_PROJECTS_VALUE, selectProjectAxis } from "./settingsScopeAxis";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_LABEL = msg("Settings");

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": msg("Diagnostics"),
  "/settings/open-source-licenses": msg("Open source licenses"),
};

function normalizeSettingsPathname(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const gt = useGT();
  const m = useMessages();
  const scope = useOptionalSettingsScope();
  const normalizedPathname = normalizeSettingsPathname(pathname);
  const sectionLabel = SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
  // A picked project turns Projects into its parent, so the list stays one click away.
  const project =
    normalizedPathname === "/settings/projects" && scope?.search.project
      ? scope.groups.find((group) => group.projectKey === scope.search.project)
      : undefined;

  return (
    <WorkspaceBreadcrumb ariaLabel={gt("Settings breadcrumb")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{m(SETTINGS_LABEL)}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {scope && project && sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>
            <button
              type="button"
              className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => scope.selectScope(selectProjectAxis(scope.search, ALL_PROJECTS_VALUE))}
            >
              {m(sectionLabel)}
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="truncate">
            {project.displayName}
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
