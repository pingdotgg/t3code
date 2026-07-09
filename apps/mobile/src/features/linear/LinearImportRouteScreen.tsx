import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  type LinearIssueDetail,
  type LinearIssueLink,
  type LinearIssueSummary,
  type ModelSelection,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { formatLinearIssues } from "@t3tools/client-runtime/linear-format";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { LinearIcon } from "../../components/LinearIcon";
import { cn } from "../../lib/cn";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";

const SEARCH_LIMIT = 30;
const IMPORT_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
};

function issueLink(issue: LinearIssueDetail): LinearIssueLink {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    ...(issue.teamId ? { teamId: issue.teamId } : {}),
    ...(issue.stateType ? { stateType: issue.stateType } : {}),
    ...(issue.stateName ? { stateName: issue.stateName } : {}),
  };
}

export function LinearImportRouteScreen() {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;
  const projects = useProjects();
  const envProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [projects, environmentId],
  );

  const [projectId, setProjectId] = useState<string | null>(null);
  const activeProject: EnvironmentProject | null =
    envProjects.find((project) => project.id === projectId) ?? envProjects[0] ?? null;

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [perIssue, setPerIssue] = useState(true);
  const [importing, setImporting] = useState(false);

  const iconColor = useThemeColor("--color-primary");
  const placeholderColor = useThemeColor("--color-icon-subtle");

  const fetchIssues = useAtomCommand(linearEnvironment.fetchIssues, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 220);
    return () => clearTimeout(id);
  }, [query]);

  const search = useEnvironmentQuery(
    environmentId === null
      ? null
      : linearEnvironment.searchIssues({
          environmentId,
          input: { query: debounced, limit: SEARCH_LIMIT },
        }),
  );
  const issues = search.data?.issues ?? [];

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleImport = useCallback(async () => {
    if (environmentId === null || activeProject === null || selected.size === 0 || importing)
      return;
    setImporting(true);
    try {
      const result = await fetchIssues({ environmentId, input: { ids: [...selected] } });
      if (result._tag !== "Success" || result.value.issues.length === 0) return;
      const details = result.value.issues;

      const start = (text: string, linearIssue: LinearIssueLink | null) => {
        const metadata = makeTurnCommandMetadata();
        return startTurn({
          environmentId,
          input: buildProjectThreadStartTurnInput({
            projectId: activeProject.id,
            projectCwd: activeProject.workspaceRoot,
            threadId: metadata.threadId,
            commandId: metadata.commandId,
            messageId: metadata.messageId,
            createdAt: metadata.createdAt,
            text,
            attachments: [],
            modelSelection: IMPORT_MODEL,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceMode: "local",
            branch: null,
            worktreePath: null,
            startFromOrigin: false,
            worktreeBranchName: "",
            linearIssue,
          }),
        });
      };

      if (perIssue) {
        for (const detail of details) {
          await start(formatLinearIssues([detail], "combine"), issueLink(detail));
        }
      } else {
        await start(formatLinearIssues(details, "combine"), null);
      }
      navigation.goBack();
    } finally {
      setImporting(false);
    }
  }, [
    activeProject,
    environmentId,
    fetchIssues,
    importing,
    navigation,
    perIssue,
    selected,
    startTurn,
  ]);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<LinearIssueSummary>) => {
      const isSelected = selected.has(item.id);
      return (
        <Pressable
          className="flex-row items-center gap-3 px-4 py-3"
          onPress={() => toggle(item.id)}
        >
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-2">
              <Text className="font-t3-medium text-sm text-foreground-muted">
                {item.identifier}
              </Text>
              <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                {item.title}
              </Text>
            </View>
            {item.stateName || item.assigneeName ? (
              <Text className="text-sm text-foreground-tertiary" numberOfLines={1}>
                {[item.stateName, item.assigneeName].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
          </View>
          <SymbolView
            name={isSelected ? "checkmark.circle.fill" : "circle"}
            size={22}
            tintColor={isSelected ? iconColor : placeholderColor}
            type="monochrome"
          />
        </Pressable>
      );
    },
    [iconColor, placeholderColor, selected, toggle],
  );

  const connected = search.error === null;

  return (
    <View className="flex-1 bg-sheet">
      <View className="gap-3 px-4 pt-3">
        {envProjects.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            {envProjects.map((project) => {
              const isActive = (activeProject?.id ?? null) === project.id;
              return (
                <Pressable
                  key={project.id}
                  className={cn("rounded-full px-3 py-1.5", isActive ? "bg-primary" : "bg-card")}
                  onPress={() => setProjectId(project.id)}
                >
                  <Text
                    className={cn(
                      "text-sm font-t3-medium",
                      isActive ? "text-primary-foreground" : "text-foreground-muted",
                    )}
                  >
                    {project.title}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search Linear issues…"
          value={query}
        />
      </View>

      {search.isPending && issues.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : issues.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <LinearIcon size={28} />
          <Text className="text-center text-base text-foreground-muted">
            {connected ? "No issues found." : "Connect Linear in Settings to import issues."}
          </Text>
        </View>
      ) : (
        <LegendList
          data={issues}
          estimatedItemSize={60}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingVertical: 8 }}
        />
      )}

      <View className="gap-3 border-t border-separator px-4 pb-8 pt-3">
        <Pressable
          className="flex-row items-center justify-between"
          onPress={() => setPerIssue((value) => !value)}
        >
          <Text className="text-base text-foreground">
            {perIssue ? "One thread per issue" : "Combine into one thread"}
          </Text>
          <SymbolView
            name="arrow.left.arrow.right"
            size={16}
            tintColor={placeholderColor}
            type="monochrome"
          />
        </Pressable>
        <ConnectionSheetButton
          disabled={selected.size === 0 || activeProject === null || importing}
          icon="square.and.arrow.down"
          label={
            importing
              ? "Importing…"
              : selected.size === 0
                ? "Select issues"
                : `Import ${selected.size}`
          }
          onPress={() => void handleImport()}
          tone="primary"
        />
      </View>
    </View>
  );
}
