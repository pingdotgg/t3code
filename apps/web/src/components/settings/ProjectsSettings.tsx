import { EnvironmentId } from "@t3tools/contracts";
import { ProjectSettingsPanel, type ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

export function ProjectsSettings({
  category = "overview",
}: {
  category?: ProjectSettingsCategory;
}) {
  const { search, scope } = useSettingsScope();
  // The panel follows remembered members when grouping replaces a project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  if (search.project && projectScope) {
    return (
      <ProjectSettingsPanel
        projectKey={search.project}
        environmentId={search.machine ? EnvironmentId.make(search.machine) : null}
        checkoutKey={search.checkout ?? null}
        category={category}
      />
    );
  }
  if (scope.kind === "unavailable")
    return <p className="p-8 text-sm text-muted-foreground">{scope.message}</p>;
  return (
    <SettingsScopeNotice target="project">
      Choose a project to view its identity and checkouts.
    </SettingsScopeNotice>
  );
}
