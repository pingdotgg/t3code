import { useNavigate, useSearch } from "@tanstack/react-router";

import { useArchivedProjectModel } from "../../lib/archivedThreadsState";
import { ProjectScopeBreadcrumb } from "../ProjectScopeBreadcrumb";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const archiveProjectKey = useSearch({
    from: "/settings/archived",
    shouldThrow: false,
    select: (search) => search.project ?? null,
  });
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPathname === "/settings/archived" && archiveProjectKey !== undefined) {
    return <ArchivedThreadsBreadcrumb projectKey={archiveProjectKey} />;
  }
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}

function ArchivedThreadsBreadcrumb({ projectKey }: { projectKey: string | null }) {
  const navigate = useNavigate({ from: "/settings/archived" });
  const { isLoading, projectGroups } = useArchivedProjectModel();

  return (
    <ProjectScopeBreadcrumb
      allLabel="All"
      ariaLabel="Archive breadcrumb"
      items={projectGroups.map((group) => ({ id: group.projectKey, label: group.displayName }))}
      onSelect={(projectKey) => {
        void navigate({
          search: projectKey === null ? {} : { project: projectKey },
          replace: true,
          hashScrollIntoView: false,
        });
      }}
      rootLabel="Archive"
      selectedKey={projectKey}
      unavailableLabel={isLoading ? "Loading project" : "Unavailable project"}
    />
  );
}
