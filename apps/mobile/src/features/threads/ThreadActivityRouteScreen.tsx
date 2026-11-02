import {
  deriveActivitySummary,
  isActivityItem,
  type ActivitySummary,
} from "@t3tools/client-runtime/work-log/activity-summary";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Platform, View } from "react-native";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { cn } from "../../lib/cn";
import { useQuietThreadStructure, useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";

export type ThreadActivityRouteParams = {
  readonly environmentId: string;
  readonly threadId: string;
};

const VISIBLE_DONE_STEPS = 8;

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function StepRow(props: {
  readonly icon: AppSymbolName;
  readonly tint: string;
  readonly label: string;
  readonly emphasized?: boolean;
  readonly muted?: boolean;
  readonly trailing?: string;
  readonly onPress?: () => void;
}) {
  const content = (
    <View className="flex-row items-start gap-3 px-4 py-3">
      <View className="pt-0.5">
        <SymbolView name={props.icon} size={16} tintColorClassName={props.tint} />
      </View>
      <Text
        textRole="body"
        className={cn(
          "min-w-0 flex-1",
          props.emphasized ? "font-t3-bold text-foreground" : "text-foreground",
          props.muted && "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
      {props.trailing ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.trailing}
        </Text>
      ) : null}
    </View>
  );
  return props.onPress ? (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="bg-grouped-card"
    >
      {content}
    </RowPressable>
  ) : (
    content
  );
}

/** The one answer the screen exists for: where is the agent, and does it need me? */
function StatusBanner(props: { readonly summary: ActivitySummary }) {
  const { summary } = props;
  const { phase, plan, touchedTotals, failedCount } = summary;

  let icon: AppSymbolName = "checkmark.circle";
  let tint = "accent-icon";
  let title = "Finished";
  const details: string[] = [];
  if (phase === "waiting") {
    icon = "clock";
    tint = "accent-warning-foreground";
    title = summary.now ?? "Waiting for you";
    details.push("Paused until you respond");
  } else if (phase === "running") {
    icon = "circle.inset.filled";
    tint = "accent-icon";
    title = summary.now ?? "Working";
    if (plan) {
      details.push(
        `Step ${Math.min(plan.completed + 1, plan.steps.length)} of ${plan.steps.length}`,
      );
    }
  } else if (summary.outcome === "failed") {
    icon = "xmark.circle.fill";
    tint = "accent-danger-foreground";
    title = "Finished with errors";
    details.push(`${plural(failedCount, "step")} failed`);
    if (plan) details.push(`${plan.completed} of ${plural(plan.steps.length, "step")}`);
    if (touchedTotals.files > 0) details.push(`${plural(touchedTotals.files, "file")} changed`);
  } else {
    if (summary.outcome === "incomplete" && plan) {
      icon = "exclamationmark.circle";
      tint = "accent-warning-foreground";
      title = "Stopped with steps left";
      details.push(`${plan.completed} of ${plural(plan.steps.length, "step")} done`);
    } else if (plan) {
      details.push(`${plan.completed} of ${plural(plan.steps.length, "step")}`);
    }
    if (touchedTotals.files > 0) details.push(`${plural(touchedTotals.files, "file")} changed`);
  }

  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      className={cn(
        "flex-row items-start gap-3 rounded-[22px] border px-4 py-4",
        phase === "waiting" ? "border-warning-border bg-warning" : "border-border bg-card",
      )}
    >
      <View className="pt-0.5">
        <SymbolView name={icon} size={20} tintColorClassName={tint} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {details.join(" · ")}
          {summary.lastActivityAt ? (
            <>
              {details.length > 0 ? " · " : null}
              Updated <RelativeTime timestamp={summary.lastActivityAt} />
            </>
          ) : null}
        </Text>
      </View>
    </View>
  );
}

export function ThreadActivityRouteScreen(props: StaticScreenProps<ThreadActivityRouteParams>) {
  const navigation = useNavigation();
  const isAndroid = Platform.OS === "android";
  const params = props.route.params;
  const { selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  // The route's own thread, so a deep link shows the thread in its URL, not the selected one.
  const visibleItems = useThreadVisibleTurnItems({
    environmentId: EnvironmentId.make(params.environmentId),
    threadId: ThreadId.make(params.threadId),
  });
  const structure = useQuietThreadStructure(
    scopeThreadRef(EnvironmentId.make(params.environmentId), ThreadId.make(params.threadId)),
  );
  const runActive =
    structure !== null && threadRuntimeIsActive(deriveThreadStructureRuntime(structure.projection));
  const summary = deriveActivitySummary(
    visibleItems.map((visible) => visible.item).filter(isActivityItem),
    selectedThreadCwd ?? selectedThreadProject?.workspaceRoot ?? null,
    runActive,
  );

  const handleBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: params.environmentId,
        threadId: params.threadId,
      }),
    );
  };
  const openFile = (path: string) => {
    navigation.navigate("ThreadFile", {
      environmentId: params.environmentId,
      threadId: params.threadId,
      path: path.split("/").filter((segment) => segment.length > 0),
    });
  };

  const isEmpty =
    summary.phase === "idle" &&
    summary.now === null &&
    summary.done.length === 0 &&
    summary.touched.length === 0 &&
    summary.plan === null;
  const hiddenDone = Math.max(0, summary.done.length - VISIBLE_DONE_STEPS);

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: !isAndroid,
          headerTitle: "Activity",
          title: "Activity",
        }}
      />
      {isAndroid ? <AndroidScreenHeader title="Activity" onBack={handleBack} /> : null}
      {isEmpty ? (
        <View className="flex-1 justify-center px-4">
          <EmptyState
            variant="plain"
            title="Nothing to show yet"
            detail="Progress appears here while the agent works: what it is doing, what it finished, and which files it changed."
          />
        </View>
      ) : (
        <NativeScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-5 px-4 py-4"
        >
          <StatusBanner summary={summary} />
          {summary.plan ? (
            <ListSection title={`Plan · ${summary.plan.completed} of ${summary.plan.steps.length}`}>
              {summary.plan.steps.map((step) => (
                <StepRow
                  key={step.id}
                  icon={step.status === "completed" ? "checkmark" : "circle"}
                  tint={step.status === "running" ? "accent-icon" : "accent-icon-muted"}
                  label={step.text}
                  emphasized={step.status === "running"}
                  muted={step.status !== "running"}
                />
              ))}
            </ListSection>
          ) : null}
          {summary.touched.length > 0 ? (
            <ListSection title={`Files touched · ${summary.touchedTotals.files}`}>
              {summary.touched.flatMap((folder) =>
                folder.files.map((file) => (
                  <StepRow
                    key={file.path}
                    icon="doc.text"
                    tint="accent-icon-muted"
                    label={file.path}
                    trailing={
                      file.openable
                        ? file.additions === null && file.deletions === null
                          ? undefined
                          : `+${file.additions ?? 0} -${file.deletions ?? 0}`
                        : "Outside workspace"
                    }
                    {...(file.openable ? { onPress: () => openFile(file.path) } : {})}
                  />
                )),
              )}
            </ListSection>
          ) : null}
          {summary.done.length > 0 ? (
            <ListSection title={`Done this turn · ${summary.done.length}`}>
              {hiddenDone > 0 ? (
                <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
                  {plural(hiddenDone, "earlier step")} not shown
                </Text>
              ) : null}
              {summary.done.slice(hiddenDone).map((step) => (
                <StepRow
                  key={step.id}
                  icon={step.failed ? "xmark" : "checkmark"}
                  tint={step.failed ? "accent-danger-foreground" : "accent-icon-muted"}
                  label={step.label}
                />
              ))}
            </ListSection>
          ) : null}
        </NativeScrollView>
      )}
    </View>
  );
}
