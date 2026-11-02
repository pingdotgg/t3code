import { useNavigation } from "@react-navigation/native";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";

import { useEnvironmentsWithScope } from "../../state/session";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { BranchPickerScreen } from "../threads/NewTaskContextPickerScreens";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function WorktreeBaseBranchPickerRouteScreen() {
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const members = projectGroups.find((group) => group.key === selectedProjectKey)?.members ?? [];
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    members.map((member) => member.project),
  );
  const project =
    members.find((member) =>
      targets.some((target) => target.environment.environmentId === member.project.environmentId),
    )?.project ?? null;
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const canWrite =
    targets.length > 0 && targets.every((target) => writable.has(target.environment.environmentId));
  const writeSettings = useSettingsWriter();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const branches = usePaginatedBranches({
    environmentId: project?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
    query: debouncedQuery,
  });
  const visibleBranches = branches.refs.filter((branch) =>
    branch.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const value = uniformMobileSetting(targets, "newWorktreesBaseBranch");
  const select = (newWorktreesBaseBranch: string) => {
    void Haptics.selectionAsync();
    void writeSettings(
      targets,
      planMobileScopedSettingsPatch(targets, true, { newWorktreesBaseBranch }),
    );
    navigation.goBack();
  };

  return (
    <BranchPickerScreen
      title="Base branch"
      project={project}
      branches={visibleBranches}
      selectedBranchName={value ?? ""}
      query={query}
      onQueryChange={setQuery}
      loading={
        query.trim() !== debouncedQuery.trim() || (branches.isPending && branches.data === null)
      }
      error={project ? branches.error : "Choose a project to list its branches."}
      refreshing={branches.isFetchingNextPage}
      hasMore={branches.data?.nextCursor != null}
      onRefresh={branches.refresh}
      onLoadMore={branches.loadNext}
      selectionDisabled={!canWrite}
      onSelect={(branch) => select(branch.name)}
      defaultOption={{
        title: "Repository default",
        selected: value === "",
        onSelect: () => select(""),
      }}
    />
  );
}
