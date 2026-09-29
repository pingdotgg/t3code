import { translate } from "@t3tools/i18n";
import type { WorktreeSetupSnapshot, WorktreeSetupStage } from "@t3tools/contracts";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useEffect, useState } from "react";
import { useTranslation } from "@t3tools/i18n/react";
import { ActivityIndicator, AppState, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { WorktreeSetupSheet } from "./worktree-setup-sheet";
import { ShimmeringWorkContent } from "./thread-work-log";

export interface WorktreeSetupCardProps {
  snapshot: WorktreeSetupSnapshot;
  turnStarted: boolean;
  turnStartedAt: string | null;
  working: boolean;
  onCancel: () => void;
  onWorkLocally: (() => void) | null;
}

function elapsed(start: string | null, end: string | null, now: number) {
  const duration = (end ? Date.parse(end) : now) - (start ? Date.parse(start) : NaN);
  return Number.isFinite(duration) ? formatDuration(Math.max(0, duration)) : null;
}

const icons: Record<WorktreeSetupStage["status"], AppSymbolName> = {
  pending: "circle",
  running: "clock",
  done: "checkmark",
  skipped: "minus",
  failed: "xmark",
  warning: "exclamationmark.triangle",
};

/** Setup stages collapse into the working header once the agent's turn is live. */
export function WorktreeSetupCard(props: WorktreeSetupCardProps) {
  const { snapshot, turnStarted, turnStartedAt, working } = props;
  const handedOff = turnStarted && worktreeSetupAgentStarted(snapshot);
  const running = snapshot.phase === "running";
  const backgroundSetup = handedOff && running;
  const scriptName =
    snapshot.setupScript?.name ?? translate("common:mobileUiSetupScript", "Setup script");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const now = useSetupClock(running || working);
  const failed =
    snapshot.phase === "failed" || snapshot.stages.some((stage) => stage.status === "failed");
  const label =
    handedOff && working
      ? translate("common:mobileUiWorkingFor", "Working for {{duration}}", {
          duration: elapsed(turnStartedAt, null, now) ?? "0s",
        })
      : running
        ? handedOff
          ? translate("common:mobileUiSetupContinue", "Setup continues…")
          : translate("common:mobileUiSettingUpWorktree", "Setting up worktree…")
        : snapshot.phase === "cancelled"
          ? translate("common:mobileUiSetupCancelled", "Worktree setup cancelled")
          : snapshot.phase === "failed"
            ? translate("common:mobileUiSetupFailed", "Worktree setup failed")
            : failed
              ? translate("common:mobileUiSetupScriptFailed", "Setup script failed")
              : translate("common:mobileUiWorktreeReady", "Worktree ready");

  return (
    <View
      accessibilityLabel={translate("common:mobileWorktreeSetup", "Worktree setup")}
      className="py-1"
    >
      <View className="min-h-11 flex-row items-center gap-2 border-b border-border px-1">
        <HeaderLabel
          label={label}
          active={(running || working) && !detailsOpen}
          failed={failed && !working}
        />
        {!handedOff ? (
          <Text
            className="text-2xs text-foreground-secondary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {elapsed(snapshot.startedAt, snapshot.endedAt, now)}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            backgroundSetup
              ? translate(
                  "common:mobileUiSetupRunning",
                  "{{script}} is still running. Show setup progress.",
                  { script: scriptName },
                )
              : translate("common:mobileUiWorktreeSetupDetails", "Worktree setup details")
          }
          accessibilityState={{ expanded: detailsOpen }}
          onPress={() => setDetailsOpen(true)}
          className="min-h-11 max-w-[55%] justify-center px-2"
        >
          <View
            className={
              backgroundSetup
                ? "min-w-0 flex-row items-center gap-1 rounded-full border border-border px-2 py-1"
                : "flex-row items-center gap-1"
            }
          >
            {backgroundSetup ? (
              <ActivityIndicator
                size="small"
                colorClassName="accent-icon-muted"
                style={{ width: 12, height: 12, transform: [{ scale: 0.65 }] }}
              />
            ) : failed ? (
              <SymbolView
                name="exclamationmark.circle"
                size={12}
                tintColorClassName="accent-danger-foreground"
              />
            ) : null}
            <Text numberOfLines={1} className="shrink text-2xs text-foreground-secondary">
              {backgroundSetup ? scriptName : translate("common:mobileUiDetails", "Details")}
            </Text>
            {!backgroundSetup ? (
              <SymbolView name="chevron.right" size={10} tintColorClassName="accent-icon-muted" />
            ) : null}
          </View>
        </Pressable>
      </View>
      {!handedOff ? (
        <View className="pt-1 pb-2">
          {snapshot.stages
            .filter((stage) => stage.id !== "agent")
            .map((stage) => (
              <StageRow
                key={stage.id}
                stage={stage}
                scriptName={snapshot.setupScript?.name ?? null}
                now={now}
                compact
                animate={!detailsOpen}
              />
            ))}
        </View>
      ) : null}
      {detailsOpen ? (
        <SetupDetailsSheet {...props} now={now} onClose={() => setDetailsOpen(false)} />
      ) : null}
    </View>
  );
}

export function WorktreeWorkingHeader({ startedAt }: { startedAt: string }) {
  const now = useSetupClock(true);
  return (
    <View className="py-1">
      <View className="min-h-11 flex-row items-center border-b border-border px-1">
        <HeaderLabel
          label={translate("common:mobileUiWorkingFor", "Working for {{duration}}", {
            duration: elapsed(startedAt, null, now) ?? "0s",
          })}
          active
        />
      </View>
    </View>
  );
}

function HeaderLabel({
  label,
  active,
  failed = false,
}: {
  label: string;
  active: boolean;
  failed?: boolean;
}) {
  return active ? (
    <ShimmeringWorkContent
      icon="clock"
      iconSubtleColor="transparent"
      label={label}
      showIcon={false}
    />
  ) : (
    <Text
      numberOfLines={1}
      className={
        failed
          ? "flex-1 text-sm text-danger-foreground"
          : "flex-1 text-sm text-foreground-secondary"
      }
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {label}
    </Text>
  );
}

function useSetupClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  const [appState, setAppState] = useState(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!active || appState !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, appState]);
  return now;
}

function SetupDetailsSheet({
  snapshot,
  turnStarted,
  onCancel,
  onWorkLocally,
  onClose,
  now,
}: WorktreeSetupCardProps & { onClose: () => void; now: number }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [bodyHeight, setBodyHeight] = useState(0);
  const canCancel = snapshot.phase === "running" && !turnStarted;
  return (
    <WorktreeSetupSheet height={bodyHeight} onClose={onClose}>
      <ScrollView
        bounces={false}
        onContentSizeChange={(_width, height) => setBodyHeight(height)}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {/* Agent startup is the header handoff, not a fifth setup step. */}
        {snapshot.stages
          .filter((stage) => stage.id !== "agent")
          .map((stage) => (
            <View key={stage.id}>
              <StageRow stage={stage} scriptName={snapshot.setupScript?.name ?? null} now={now} />
              {stage.id === "setup-script" &&
              (stage.status === "running" || stage.status === "failed" || stage.tail.length > 0) ? (
                <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
              ) : null}
            </View>
          ))}
        {snapshot.phase === "failed" && snapshot.error ? (
          <Text selectable className="ml-8 mt-2 text-xs text-danger-foreground">
            {snapshot.error}
          </Text>
        ) : null}
        {canCancel ? (
          <View className="mt-3 flex-row items-center justify-end gap-4 border-t border-border pt-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={translate(
                "common:mobileCancelWorktreeSetup",
                "Cancel worktree setup",
              )}
              onPress={() => {
                onClose();
                onCancel();
              }}
              className="min-h-11 justify-center px-2"
            >
              <Text className="text-sm text-danger-foreground">{t("cancelSetup")}</Text>
            </Pressable>
            {onWorkLocally ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  onWorkLocally();
                }}
                className="min-h-11 justify-center px-2"
              >
                <Text className="text-sm text-foreground">{t("workLocally")}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </WorktreeSetupSheet>
  );
}

function StageRow({
  stage,
  scriptName,
  now,
  compact = false,
  animate = true,
}: {
  stage: WorktreeSetupStage;
  scriptName: string | null;
  now: number;
  compact?: boolean;
  animate?: boolean;
}) {
  const label =
    stage.id === "setup-script" && scriptName ? scriptName : localizedWorktreeStageLabel(stage.id);
  const detail =
    stage.status === "pending"
      ? null
      : stage.status === "skipped"
        ? (stage.detail ?? translate("common:mobileUiStageSkipped", "Skipped"))
        : stage.id === "checkout" && stage.status === "running" && stage.percent !== null
          ? `${stage.percent}%`
          : stage.detail;
  return (
    <View
      accessibilityLabel={translate(
        "common:mobileUiStageAccessibilityLabel",
        "{{label}}, {{status}}",
        {
          label,
          status: localizedWorktreeStageStatus(stage.status),
        },
      )}
      className={compact ? "min-h-8 flex-row items-center" : "min-h-11 flex-row items-center"}
      style={{ columnGap: 8, opacity: stage.status === "pending" ? 0.4 : 1 }}
    >
      <View className="w-6 items-center">
        {stage.status === "running" && animate ? (
          <ActivityIndicator
            size="small"
            colorClassName="accent-icon-muted"
            style={{ transform: [{ scale: 0.75 }] }}
          />
        ) : (
          <SymbolView
            name={icons[stage.status]}
            size={14}
            tintColorClassName={
              stage.status === "failed"
                ? "accent-danger-foreground"
                : stage.status === "warning"
                  ? "accent-warning-foreground"
                  : "accent-icon-muted"
            }
          />
        )}
      </View>
      {stage.status === "running" && animate ? (
        <ShimmeringWorkContent
          icon="clock"
          iconSubtleColor="transparent"
          label={label}
          showIcon={false}
        />
      ) : (
        <Text
          numberOfLines={1}
          className={
            stage.status === "failed"
              ? "flex-1 text-sm text-danger-foreground"
              : "flex-1 text-sm text-foreground-secondary"
          }
        >
          {label}
        </Text>
      )}
      {detail ? (
        <Text numberOfLines={1} className="max-w-[25%] shrink text-2xs text-foreground-secondary">
          {detail}
        </Text>
      ) : null}
      {stage.status !== "pending" && stage.status !== "skipped" ? (
        <Text
          className="text-2xs text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {elapsed(stage.startedAt, stage.endedAt, now)}
        </Text>
      ) : null}
    </View>
  );
}

function localizedWorktreeStageLabel(stage: WorktreeSetupStage["id"]) {
  switch (stage) {
    case "fetch":
      return translate("common:mobileUiStageFetchBaseBranch", "Fetch base branch");
    case "checkout":
      return translate("common:mobileUiStageCheckout", "Check out files");
    case "submodules":
      return translate("common:mobileUiStageSubmodules", "Init submodules");
    case "setup-script":
      return translate("common:mobileUiStageSetupScript", "Run setup script");
    case "agent":
      return translate("common:mobileUiStageAgent", "Start agent");
  }
}

function localizedWorktreeStageStatus(status: WorktreeSetupStage["status"]) {
  switch (status) {
    case "pending":
      return translate("common:mobileUiStagePending", "Pending");
    case "running":
      return translate("common:mobileUiStageRunning", "Running");
    case "done":
      return translate("common:mobileUiStageDone", "Done");
    case "skipped":
      return translate("common:mobileUiStageSkipped", "Skipped");
    case "warning":
      return translate("common:mobileUiStageWarning", "Warning");
    case "failed":
      return translate("common:mobileUiStageFailed", "Failed");
  }
}

const OUTPUT_TAIL_SLOTS = [0, 1, 2, 3] as const;

/** Fixed four-line output window, shown only in Details. */
function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  return (
    <View
      accessibilityLabel={translate("common:mobileSetupScriptOutput", "Setup script output")}
      className={
        failed
          ? "mb-2 ml-8 rounded-md border border-danger-border bg-danger px-3 py-2"
          : "mb-2 ml-8 rounded-md border border-border bg-card-alt px-3 py-2"
      }
    >
      {OUTPUT_TAIL_SLOTS.map((slot) => (
        <Text
          key={slot}
          selectable
          numberOfLines={1}
          className={
            failed
              ? "text-2xs leading-5 text-danger-foreground ios:font-[family-name:Menlo] android:font-mono"
              : "text-2xs leading-5 text-foreground-secondary ios:font-[family-name:Menlo] android:font-mono"
          }
        >
          {lines[lines.length - OUTPUT_TAIL_SLOTS.length + slot] || "\u00a0"}
        </Text>
      ))}
    </View>
  );
}
