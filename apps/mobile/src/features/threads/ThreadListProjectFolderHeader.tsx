import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { useEnvironmentScope } from "../../state/session";
import type { ThreadListV2ProjectFolderListItem } from "./threadListV2";

const STATUS_COLOR = {
  attention: "bg-warning-foreground",
  failed: "bg-danger-foreground",
  unread: "bg-adaptive-emerald-700-300",
  working: "bg-adaptive-sky-600-400",
} as const;

const STATUS_LABEL = {
  attention: "Needs you",
  failed: "Failed",
  unread: "Done",
  working: "Working",
} as const;

export const ThreadListProjectFolderHeader = memo(function ThreadListProjectFolderHeader(props: {
  readonly item: ThreadListV2ProjectFolderListItem;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: (projectKey: string) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const { item, onToggle, onNewThread } = props;
  const project = item.scope.representative;
  const canCreate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const sidebar = props.pane === "sidebar";
  const statusLabel = item.status === null ? "" : `, ${STATUS_LABEL[item.status]}`;
  return (
    <View className={cn("mt-2 flex-row items-center", sidebar ? "px-3" : "px-5")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.scope.title}, ${item.hiddenCount} hidden threads${statusLabel}`}
        accessibilityHint={item.expanded ? "Collapses the project" : "Expands the project"}
        accessibilityState={{ expanded: item.expanded, disabled: item.disabled }}
        disabled={item.disabled}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
        onPress={() => onToggle(item.scope.key)}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <ProjectFavicon
          environmentId={project.environmentId}
          projectTitle={item.scope.title}
          workspaceRoot={project.workspaceRoot}
          faviconPath={project.faviconPath}
          projectIcon={project.projectIcon}
          size={18}
        />
        <Text
          numberOfLines={1}
          className={cn(
            "min-w-0 flex-1 text-sm font-t3-medium",
            sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
        >
          {item.scope.title}
        </Text>
        {item.status !== null ? (
          <View className={cn("size-1.5 rounded-full", STATUS_COLOR[item.status])} />
        ) : null}
        {!item.expanded && item.hiddenCount > 0 ? (
          <Text className="text-xs text-foreground-muted">{item.hiddenCount}</Text>
        ) : null}
        <SymbolView
          name={item.expanded ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName={
            sidebar ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
          }
        />
      </Pressable>
      {!item.scope.archived && canCreate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New thread in ${item.scope.title}`}
          disabled={item.disabled}
          className="min-h-11 min-w-11 items-center justify-center"
          onPress={() => onNewThread(project)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <SymbolView
            name="square.and.pencil"
            size={16}
            tintColorClassName={
              sidebar ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
            }
          />
        </Pressable>
      ) : null}
    </View>
  );
});
