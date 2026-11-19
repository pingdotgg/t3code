import { msg, T, useGT, useMessages } from "gt-react";

import { Badge } from "../ui/badge";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_LABEL = msg("Settings");

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": msg("Diagnostics"),
  "/settings/open-source-licenses": msg("Open source licenses"),
};

const BETA_SETTINGS_PATHS: ReadonlySet<string> = new Set(["/settings/computer-use"]);

function normalizeSettingsPathname(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const gt = useGT();
  const m = useMessages();
  const normalizedPathname = normalizeSettingsPathname(pathname);
  const sectionLabel = SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;

  return (
    <WorkspaceBreadcrumb ariaLabel={gt("Settings breadcrumb")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{m(SETTINGS_LABEL)}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="gap-2 truncate">
        {m(sectionLabel ?? SETTINGS_LABEL)}
        {BETA_SETTINGS_PATHS.has(normalizedPathname) ? (
          <Badge variant="info" size="sm">
            <T>Beta</T>
          </Badge>
        ) : null}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
