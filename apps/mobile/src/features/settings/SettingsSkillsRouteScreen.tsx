import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, SkillReviewListItem } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { skillEnvironment } from "../../state/skills";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { hasSkillsCapability, skillCellEvidenceSummary } from "./skills-mobile";

function matchesSearch(item: SkillReviewListItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    item.skillName,
    item.description ?? "",
    ...item.providers,
    ...item.cells.flatMap((cell) => [cell.driver, cell.model]),
  ].some((value) => value.toLowerCase().includes(normalized));
}

function skillDescription(item: SkillReviewListItem): string {
  const evidence = item.cells.length
    ? item.cells.map(skillCellEvidenceSummary)
    : ["No model evidence yet"];
  return [...(item.description ? [item.description] : []), ...evidence].join("\n");
}

function EnvironmentSkills({
  environmentId,
  label,
  query,
  supported,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly query: string;
  readonly supported: boolean;
}) {
  const navigation = useNavigation();
  const skills = useEnvironmentQuery(
    supported ? skillEnvironment.reviewList({ environmentId, input: {} }) : null,
  );
  const visible = (skills.data ?? []).filter((item) => matchesSearch(item, query));

  if (!supported) {
    return (
      <SettingsSection title={label}>
        <Text className="p-4 text-sm text-foreground-muted">Update this server to use Skills</Text>
      </SettingsSection>
    );
  }

  if (skills.error) {
    return (
      <SettingsSection title={label}>
        <Text accessibilityRole="alert" className="p-4 text-sm text-danger-foreground">
          {skills.error}
        </Text>
        <View className="border-t border-border-subtle">
          <ListActionRow label="Try again" onPress={skills.refresh} />
        </View>
      </SettingsSection>
    );
  }

  if (skills.data === null) {
    return (
      <SettingsSection title={label}>
        <Text className="p-4 text-sm text-foreground-muted">Loading skills…</Text>
      </SettingsSection>
    );
  }

  if (visible.length === 0) {
    return (
      <SettingsSection title={label}>
        <Text className="p-4 text-sm text-foreground-muted">
          {skills.data.length === 0
            ? "No provider skills were found in this environment."
            : "No skills match this search."}
        </Text>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={label}>
      {visible.map((item, index) => (
        <View
          key={item.skillName}
          className={index === 0 ? undefined : "border-t border-border-subtle"}
        >
          <ListRow
            label={item.skillName}
            description={skillDescription(item)}
            onPress={() =>
              navigation.navigate("SettingsSkillDetail", {
                environmentId,
                skillName: item.skillName,
              })
            }
          />
        </View>
      ))}
    </SettingsSection>
  );
}

export function SettingsSkillsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const [query, setQuery] = useState("");

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen
        title="Skills"
        trailing={<AndroidSettingsEnvironmentFilter />}
        search={{ value: query, onChangeText: setQuery, placeholder: "Search skills" }}
      >
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <EmptyState
              variant="plain"
              title="No environment selected"
              detail="Select a connected environment to review its skills."
            />
          ) : (
            <>
              <View className="px-2">
                <Text className="text-sm leading-relaxed text-foreground-muted">
                  Controlled eval verdicts show effect, 95% confidence interval, and evaluated task
                  count for each model.
                </Text>
              </View>
              {selectedTargets.map((environment) => (
                <EnvironmentSkills
                  key={environment.environmentId}
                  environmentId={environment.environmentId}
                  label={environment.label}
                  query={query}
                  supported={hasSkillsCapability(environment.serverConfig.environment.capabilities)}
                />
              ))}
              <View className="px-2">
                <Text className="text-sm leading-relaxed text-foreground-muted">
                  Edit or fork skill bodies and start evaluations on web or desktop, or through an
                  agent using the Skills MCP tools.
                </Text>
              </View>
            </>
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}
