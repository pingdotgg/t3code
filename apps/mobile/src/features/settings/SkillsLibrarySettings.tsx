import { useGT, useMessages } from "gt-react-native";
import { LegendList } from "@legendapp/list/react-native";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  filterSkillsLibraryIssues,
  skillsLibraryIssues,
  skillsLibraryIssueSummary,
  type SkillsLibraryIssue,
} from "@t3tools/client-runtime/skills-library-issues";
import { useState } from "react";
import { Platform, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestSearchSheet } from "../pull-requests/PullRequestSearchSheet";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";

export function SkillsLibrarySettings({ environment }: { readonly environment: SettingsTarget }) {
  return environment.serverConfig.environment.capabilities.skillsLibrary === true ? (
    <LibraryControls environment={environment} />
  ) : null;
}

function LibraryControls({ environment }: { readonly environment: SettingsTarget }) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const environmentId = environment.environmentId;
  const enabled = environment.serverConfig.settings.skillsLibraryEnabled;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canRefresh = useAtomValue(
    serverEnvironment.refreshSkillsLibrary.permissionAtom(environmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refreshLibrary = useAtomCommand(serverEnvironment.refreshSkillsLibrary, {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    serverEnvironment.skillsLibraryStatus({ environmentId, input: {} }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success") return false;
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    return true;
  };
  const refresh = (next?: boolean) => {
    if (pending || !canRefresh || (next !== undefined && !canWrite)) return;
    setPending(true);
    setError(null);
    const reconcile = async () => {
      if (
        next !== undefined &&
        failed(
          await updateSettings({ environmentId, input: { patch: { skillsLibraryEnabled: next } } }),
        )
      )
        return;
      const result = await refreshLibrary({ environmentId, input: {} });
      if (!failed(result)) status.refresh();
    };
    return reconcile()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending(false));
  };
  const failure = error ?? status.error;
  const needsRefresh = enabled || failure !== null || (status.data?.linked.length ?? 0) > 0;
  const issueSummary = status.data ? skillsLibraryIssueSummary(status.data, messages) : null;
  return (
    <>
      <SettingsSwitchRow
        icon="square.grid.2x2"
        label={gt("Skills library")}
        subtitle={gt(
          "Share skills across providers and accounts. Off restores separate skill folders.",
        )}
        value={enabled}
        disabled={pending || !canWrite || !canRefresh}
        onValueChange={(next) => void refresh(next)}
      />
      {needsRefresh && canRefresh ? (
        <ListActionRow
          icon="arrow.clockwise"
          label={gt("Refresh skills library")}
          description={gt("Update shared folders after fixing an issue or adding a skill.")}
          loading={pending}
          onPress={() => void refresh()}
        />
      ) : null}
      {failure ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      {issueSummary ? (
        <ListRow
          icon="exclamationmark.triangle"
          label={gt("Skill issues")}
          description={issueSummary}
          onPress={() => navigation.navigate("SettingsSkillsLibraryIssues", { environmentId })}
        />
      ) : null}
    </>
  );
}

export function SkillsLibraryIssuesRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId } = route.params;
  const { environments } = useEnvironments();
  const label =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    gt("this environment");
  const status = useEnvironmentQuery(
    serverEnvironment.skillsLibraryStatus({ environmentId, input: {} }),
  );
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const issues = filterSkillsLibraryIssues(
    status.data ? skillsLibraryIssues(status.data, messages) : [],
    query,
  );
  const summary = status.data ? skillsLibraryIssueSummary(status.data, messages) : null;
  return (
    <PullRequestSearchSheet
      title={gt("Skill issues")}
      placeholder={gt("Search skills or paths")}
      closeAccessibilityLabel={gt("Close skill issues")}
      clearAccessibilityLabel={gt("Clear skill issue search")}
      query={query}
      onQueryChange={setQuery}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={issues}
          keyExtractor={(issue) => issue.key}
          extraData={{ openKey, count: issues.length }}
          estimatedItemSize={72}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          ListHeaderComponent={
            <Text className="pb-3 text-xs text-foreground-muted">
              {status.error ??
                (summary
                  ? gt("{summary} on {environment}. Fix them, then refresh the skills library.", {
                      summary,
                      environment: label,
                    })
                  : gt("Skills library issues on {environment}.", { environment: label }))}
            </Text>
          }
          renderItem={({ item, index }) => (
            <SkillsLibraryIssueRow
              issue={item}
              first={index === 0}
              last={index === issues.length - 1}
              open={openKey === item.key}
              onToggle={() => setOpenKey((current) => (current === item.key ? null : item.key))}
            />
          )}
          ListEmptyComponent={
            !status.data && status.error === null ? (
              <AppActivityIndicator className="my-8" />
            ) : status.error ? undefined : (
              <EmptyState
                title={query.trim() ? gt("No issues match") : gt("No skill issues")}
                detail={
                  query.trim()
                    ? gt("Try another skill name or path.")
                    : gt(
                        "The skills library on {environment} has no conflicts or name mismatches.",
                        { environment: label },
                      )
                }
                variant="plain"
              />
            )
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}

function SkillsLibraryIssueRow(props: {
  readonly issue: SkillsLibraryIssue;
  readonly first: boolean;
  readonly last: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const { issue } = props;
  return (
    <View
      className={cn(
        "overflow-hidden bg-grouped-card",
        props.first && "rounded-t-2xl",
        props.last && "rounded-b-2xl",
        !props.first && "border-t border-border-subtle",
      )}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${issue.name}, ${issue.kind}`}
        accessibilityHint={props.open ? gt("Hides details") : gt("Shows paths and how to fix it")}
        accessibilityState={{ expanded: props.open }}
        onPress={props.onToggle}
        className="gap-1 px-4 py-3"
      >
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {issue.name}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {issue.kind}
        </Text>
      </RowPressable>
      {props.open ? (
        <View className="gap-2 px-4 pb-3">
          {issue.paths.map((path) => (
            <Text key={path} selectable className="font-mono text-xs text-foreground">
              {path}
            </Text>
          ))}
          <Text selectable className="text-sm text-foreground-muted">
            {issue.guidance}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
