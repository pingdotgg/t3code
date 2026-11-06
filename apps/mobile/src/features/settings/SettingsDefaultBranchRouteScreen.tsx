import { useNavigation } from "@react-navigation/native";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { defaultBranchOptions } from "@t3tools/shared/git";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { vcsEnvironment } from "../../state/vcs";
import { BranchPickerScreen } from "../threads/NewTaskContextPickerScreens";
import { SettingsRow } from "./components/SettingsRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  managedSettingReason,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

function useDefaultBranchProject() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const members = group?.members.map((member) => member.project) ?? [];
  const targets = resolveMobileSettingsTargets(selectedTargets, members);
  const reference = targets[0] ?? null;
  const project =
    members.find(
      (member) =>
        member.id === reference?.projectId &&
        member.environmentId === reference.environment.environmentId,
    ) ?? null;
  const mixed = targets.some(
    (target) => target.settings.defaultBranch !== reference?.settings.defaultBranch,
  );
  const disabled =
    targets.length === 0 ||
    targets.some(
      (target) => !readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
    ) ||
    managedSettingReason(targets, "defaultBranch") !== undefined;
  return { targets, reference, project, mixed, disabled };
}

export function DefaultBranchSettingsRow(props: { readonly disabled: boolean }) {
  const navigation = useNavigation();
  const { reference, project, mixed } = useDefaultBranchProject();
  const value = reference?.settings.defaultBranch ?? null;
  const selected = useEnvironmentQuery(
    project && value !== null
      ? vcsEnvironment.listRefs({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot, query: value, limit: 100 },
        })
      : null,
  );
  const unavailable =
    value !== null &&
    selected.data !== null &&
    !defaultBranchOptions(selected.data.refs, selected.data.primaryRemoteName ?? null).some(
      (branch) => branch.name === value,
    );
  return (
    <SettingsRow
      icon="arrow.triangle.branch"
      label="Default branch"
      value={
        mixed
          ? "Mixed"
          : value === null
            ? "Automatic"
            : `${value}${unavailable ? " (unavailable)" : ""}`
      }
      disabled={props.disabled}
      onPress={() => navigation.navigate("SettingsDefaultBranch")}
    />
  );
}

export function SettingsDefaultBranchRouteScreen() {
  const navigation = useNavigation();
  const { targets, reference, project, mixed, disabled } = useDefaultBranchProject();
  const write = useSettingsWriter();
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const branches = usePaginatedBranches({
    environmentId: project?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
    query: debouncedQuery,
  });
  const select = async (defaultBranch: string | null) => {
    if (disabled || saving) return;
    setSaving(true);
    const saved = await write(
      targets,
      planMobileScopedSettingsPatch(targets, true, { defaultBranch }),
    ).finally(() => setSaving(false));
    if (saved) navigation.goBack();
  };
  return (
    <BranchPickerScreen
      title="Default branch"
      project={project}
      branches={defaultBranchOptions(branches.refs, branches.data?.primaryRemoteName ?? null)}
      selectedBranchName={mixed ? "" : (reference?.settings.defaultBranch ?? "")}
      query={query}
      onQueryChange={setQuery}
      loading={query !== debouncedQuery || (branches.isPending && branches.data === null)}
      error={project ? branches.error : "This project is no longer available."}
      refreshing={branches.isFetchingNextPage}
      hasMore={branches.data?.nextCursor != null}
      onRefresh={branches.refresh}
      onLoadMore={branches.loadNext}
      selectionDisabled={disabled || saving}
      onSelect={(branch) => void select(branch.name)}
      header={
        <View className="mb-3 gap-3">
          <Text className="text-sm text-foreground-muted">
            Used for new worktrees, comparisons, pull request defaults, automatic pull, and worktree
            cleanup.
          </Text>
          <ListChoiceRow
            label="Automatic"
            description="Follow the repository's default branch."
            selected={!mixed && reference?.settings.defaultBranch === null}
            disabled={disabled || saving}
            onPress={() => void select(null)}
          />
        </View>
      }
    />
  );
}
