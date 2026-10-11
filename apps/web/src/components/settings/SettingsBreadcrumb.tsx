import { Link, useSearch } from "@tanstack/react-router";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
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

/**
 * `Settings / Section`, or `Settings / Tools / name` on a skill's or MCP
 * server's page, where Tools leads back to the list it came from.
 */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);
  const skill = useSearch({ strict: false, select: (search) => search.skill });
  const server = useSearch({ strict: false, select: (search) => search.server });
  const onTools = pathname === "/settings/tools";
  const page = onTools ? (skill ?? server) : undefined;

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {page !== undefined && sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>
            {/* The settings route keeps the scope on a link without search. */}
            <Link
              to="/settings/tools"
              search={skill === undefined && server !== undefined ? { tab: "mcp" } : {}}
              replace
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {sectionLabel}
            </Link>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {page ?? sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
