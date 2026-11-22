import {
  defaultWorkflowListTab,
  groupWorkflowRuns,
  listedWorkflowRuns,
  workflowChip,
  workflowRunLists,
  workflowRunNow,
  workflowRunState,
  type WorkflowListTab,
  type WorkflowRunNode,
  type WorkflowRunTone,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsSnapshot } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useNavigation } from "@react-navigation/native";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const TABS = [
  {
    value: "needs-you",
    label: msg("Needs you", { $context: "tab, workflow runs waiting on the user" }),
  },
  { value: "running", label: msg("Running", { $context: "tab, workflow runs under way" }) },
  { value: "all", label: msg("All", { $context: "tab, all workflow runs" }) },
] as const satisfies ReadonlyArray<{ readonly value: WorkflowListTab; readonly label: string }>;

const NOTHING: Record<WorkflowListTab, string> = {
  "needs-you": msg("Nothing waits on you."),
  running: msg("Nothing is running."),
  all: msg("No runs yet."),
};

export const WORKFLOW_TONE_CLASS: Record<WorkflowRunTone, string> = {
  input: "text-warning-foreground",
  failed: "text-danger-foreground",
  working: "text-primary",
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
  const m = useMessages();
  const state = workflowRunState(props.node, m);
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
          {workflowRunNow(props.node, m)}
        </Text>
        <Text className="text-xs text-foreground-muted">
          <RelativeTime timestamp={run.updatedAt} />
        </Text>
      </View>
    </Pressable>
  );
}

/** One environment's runs in the picked list. */
function EnvironmentRuns(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly snapshot: WorkflowRunsSnapshot;
  readonly tab: WorkflowListTab;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const m = useMessages();
  const [showSkipped, setShowSkipped] = useState(false);
  const { snapshot, tab } = props;
  const visible = listedWorkflowRuns(snapshot.runs, showSkipped);
  const listed = workflowRunLists(
    groupWorkflowRuns(snapshot.workflows, visible.runs, snapshot.questions),
  )[tab];
  return (
    <View>
      {props.label === null ? null : (
        <Text className="px-5 pb-1 pt-3 font-t3-medium text-xs text-foreground-muted">
          {props.label}
        </Text>
      )}
      {listed.length === 0 ? (
        <Text className="px-5 py-6 text-center text-sm text-foreground-muted">
          {m(NOTHING[tab])}
        </Text>
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
      {tab === "all" && visible.skipped > 0 ? (
        <Pressable
          accessibilityRole="button"
          className="items-center px-5 py-4"
          onPress={() => setShowSkipped(!showSkipped)}
        >
          <Text className="text-xs text-foreground-muted">
            {showSkipped
              ? gt("Hide skipped")
              : gt("Show {count} skipped", { count: visible.skipped })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const TAB_ORDER: ReadonlyArray<WorkflowListTab> = ["needs-you", "running", "all"];

/** The Workflows tab: what waits on you first, in every environment this device is connected to. */
export function WorkflowsScreen() {
  const { environments, isReady } = useEnvironments();
  const [tab, setTab] = useState<WorkflowListTab | null>(null);
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const m = useMessages();
  const live = useAtomValue(
    serverEnvironment.workflowsLiveAcross(
      JSON.stringify(environments.map((environment) => environment.environmentId)),
    ),
  );
  if (isReady && environments.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title={gt("No environment connected")}
        detail={gt("Connect an environment to see its workflow runs.")}
      />
    );
  }
  const sections = environments.map((environment) => {
    const result = live.find((entry) => entry.environmentId === environment.environmentId)?.result;
    return {
      environment,
      snapshot: result === undefined ? null : Option.getOrNull(AsyncResult.value(result)),
      error: result?._tag === "Failure" ? formatEnvironmentQueryError(result.cause, m) : null,
    };
  });
  const withRuns = sections.flatMap(({ environment, snapshot }) =>
    snapshot !== null && snapshot.runs.length > 0 ? [{ environment, snapshot }] : [],
  );
  const settled = sections.every(({ snapshot, error }) => snapshot !== null || error !== null);
  // Open on the most pressing list any environment has.
  const opening =
    TAB_ORDER.find((candidate) =>
      withRuns.some(
        ({ snapshot }) =>
          defaultWorkflowListTab(
            groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions),
          ) === candidate,
      ),
    ) ?? "all";
  const shown = tab ?? opening;
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
    >
      {sections.flatMap(({ environment, snapshot, error }) =>
        snapshot === null && error !== null
          ? [
              <Text
                key={`error:${environment.environmentId}`}
                className="px-5 py-3 text-sm text-danger-foreground"
              >
                {environments.length > 1 ? `${environment.label}: ${error}` : error}
              </Text>,
            ]
          : [],
      )}
      {withRuns.length === 0 ? (
        settled ? (
          <EmptyState
            variant="plain"
            title={gt("No workflow runs yet")}
            detail={gt(
              "A workflow ties agents, code, schedules and questions to you into one run that survives restarts. Write one on your computer, under Workflows, then Definitions.",
            )}
          />
        ) : null
      ) : (
        <>
          <View className="px-5 pb-2 pt-3">
            <SegmentedControl
              options={TABS.map((option) => ({ ...option, label: m(option.label) }))}
              selected={shown}
              onSelect={setTab}
              role="tab"
            />
          </View>
          {withRuns.map(({ environment, snapshot }) => (
            <EnvironmentRuns
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environments.length > 1 ? environment.label : null}
              snapshot={snapshot}
              tab={shown}
            />
          ))}
        </>
      )}
    </ScreenScrollView>
  );
}
