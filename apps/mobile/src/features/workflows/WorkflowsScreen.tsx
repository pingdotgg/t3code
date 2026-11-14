import {
  defaultWorkflowListTab,
  groupWorkflowRuns,
  workflowChip,
  workflowRunLists,
  workflowRunNow,
  workflowRunState,
  type WorkflowListTab,
  type WorkflowRunNode,
  type WorkflowRunTone,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const TABS = [
  { value: "needs-you", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ readonly value: WorkflowListTab; readonly label: string }>;

const NOTHING: Record<WorkflowListTab, string> = {
  "needs-you": "Nothing waits on you.",
  running: "Nothing is running.",
  all: "No runs yet.",
};

export const WORKFLOW_TONE_CLASS: Record<WorkflowRunTone, string> = {
  input: "text-primary",
  failed: "text-danger-foreground",
  working: "text-foreground-secondary",
  quiet: "text-foreground-muted",
  done: "text-foreground-muted",
};

// The same few colours every time for one workflow, so a list is read by its marks.
const CHIP_CLASS = [
  "bg-primary/15 text-primary",
  "bg-warning/20 text-warning-foreground",
  "bg-danger/15 text-danger-foreground",
  "bg-subtle-strong text-foreground-secondary",
  "bg-foreground/10 text-foreground",
] as const;

export function WorkflowChip(props: { readonly name: string }) {
  const chip = workflowChip(props.name);
  const [surface, text] = (CHIP_CLASS[chip.tone % CHIP_CLASS.length] ?? CHIP_CLASS[0]).split(" ");
  return (
    <View className={cn("h-5 w-6 items-center justify-center rounded-md", surface)}>
      <Text className={cn("font-t3-bold text-3xs", text)}>{chip.letters}</Text>
    </View>
  );
}

function RunRow(props: { readonly node: WorkflowRunNode; readonly onOpen: () => void }) {
  const { run } = props.node;
  const state = workflowRunState(props.node);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${run.title}, ${state.word}`}
      className="gap-1 border-b border-border-subtle px-5 py-3 active:bg-subtle"
      onPress={props.onOpen}
    >
      <View className="flex-row items-center gap-2">
        <WorkflowChip name={run.workflow} />
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {run.workflow}
        </Text>
        <Text className={cn("font-t3-medium text-xs", WORKFLOW_TONE_CLASS[state.tone])}>
          {state.word}
        </Text>
      </View>
      <Text className="font-t3-medium text-base text-foreground" numberOfLines={1}>
        {run.title}
      </Text>
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {workflowRunNow(props.node)}
        </Text>
        <Text className="text-xs text-foreground-muted">
          <RelativeTime timestamp={run.updatedAt} />
        </Text>
      </View>
    </Pressable>
  );
}

/** One environment's runs in the picked list. Nothing at all for one that has never had a run. */
function EnvironmentRuns(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly tab: WorkflowListTab | null;
  readonly onTab: (tab: WorkflowListTab) => void;
}) {
  const navigation = useNavigation();
  const live = useEnvironmentQuery(
    serverEnvironment.workflowsLive({ environmentId: props.environmentId, input: {} }),
  );
  const snapshot = live.data;
  if (snapshot === null) {
    return live.error === null ? null : (
      <Text className="px-5 py-3 text-sm text-danger-foreground">{live.error}</Text>
    );
  }
  if (snapshot.runs.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="No workflow runs yet"
        detail="A workflow ties agents, code, schedules and questions to you into one run that survives restarts. Write one on your computer, under Workflows, then Definitions."
      />
    );
  }
  const groups = groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions);
  const lists = workflowRunLists(groups);
  const tab = props.tab ?? defaultWorkflowListTab(groups);
  const listed = lists[tab];
  return (
    <View>
      <View className="gap-3 px-5 pb-2 pt-3">
        {props.label === null ? null : (
          <Text className="font-t3-medium text-xs text-foreground-muted">{props.label}</Text>
        )}
        <SegmentedControl options={TABS} selected={tab} onSelect={props.onTab} role="tab" />
      </View>
      {listed.length === 0 ? (
        <Text className="px-5 py-6 text-center text-sm text-foreground-muted">{NOTHING[tab]}</Text>
      ) : (
        listed.map((node) => (
          <RunRow
            key={node.run.runId}
            node={node}
            onOpen={() =>
              navigation.navigate("WorkflowRun", {
                environmentId: props.environmentId,
                runId: node.run.runId,
              })
            }
          />
        ))
      )}
    </View>
  );
}

/** The Workflows tab: what waits on you first, in every environment this device is connected to. */
export function WorkflowsScreen() {
  const { environments, isReady } = useEnvironments();
  const [tab, setTab] = useState<WorkflowListTab | null>(null);
  if (isReady && environments.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="No environment connected"
        detail="Connect an environment to see its workflow runs."
      />
    );
  }
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      {environments.map((environment) => (
        <EnvironmentRuns
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environments.length > 1 ? environment.label : null}
          tab={tab}
          onTab={setTab}
        />
      ))}
    </ScreenScrollView>
  );
}
