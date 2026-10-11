import { useNavigation } from "@react-navigation/native";
import type { PullRequestDetail } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import {
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

export function PullRequestCardGroup(props: { readonly children: ReactNode }) {
  return (
    <View className="overflow-hidden rounded-[22px] border-continuous bg-grouped-card">
      {props.children}
    </View>
  );
}

export function PullRequestCardRow(props: {
  readonly title: string;
  readonly icon: AppSymbolName;
  readonly tint?: string;
  readonly value?: string;
  readonly detail?: string;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly destructive?: boolean;
  readonly last?: boolean;
  readonly compact?: boolean;
  readonly menu?: boolean;
  readonly expanded?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole={props.onPress || props.menu ? "button" : undefined}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={props.expanded === undefined ? undefined : { expanded: props.expanded }}
      onPress={props.onPress}
      disabled={!props.onPress && !props.menu}
      className={`${props.compact ? "min-h-11 py-2.5" : "min-h-13 py-3"} flex-row items-center gap-3 px-4 ${props.last || props.compact ? "" : "border-b border-border-subtle"} ${props.onPress ? "active:opacity-70" : ""}`}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName={
          props.destructive ? "accent-danger-foreground" : (props.tint ?? "accent-icon-muted")
        }
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={
            props.destructive
              ? "text-sm font-t3-medium text-danger-foreground"
              : "text-sm font-t3-medium"
          }
        >
          {props.title}
        </Text>
        {props.detail ? (
          <Text className="text-2xs text-foreground-muted" numberOfLines={2}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.children ??
        (props.value ? (
          <Text
            className={`${props.compact ? "max-w-[38%] text-2xs" : "max-w-[60%] text-xs"} shrink text-right text-foreground-muted`}
            numberOfLines={2}
          >
            {props.value}
          </Text>
        ) : null)}
      {props.onPress || props.menu ? (
        <SymbolView
          name={
            props.expanded === undefined
              ? "chevron.right"
              : props.expanded
                ? "chevron.up"
                : "chevron.down"
          }
          size={11}
          tintColorClassName="accent-icon-muted"
        />
      ) : null}
    </Pressable>
  );
}

export function PullRequestActionToolbar(props: {
  readonly pr: PullRequestDetail | null;
  readonly params: PullRequestParams;
  readonly filePath?: string;
  readonly onOpenFiles?: () => void;
}) {
  const navigation = useNavigation();
  const { draft } = usePullRequestReviewDraft(props.params);
  const { themeVariables: colors } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const nativeMetrics = useNativeLayoutMetrics();
  const verticalControls = nativeMetrics !== null && nativeMetrics.verticalBarEdge !== "none";
  const permissions = usePullRequestPermissions(props.params, props.pr);
  const agent = usePullRequestAgentActions(props.params, props.pr, props.filePath);
  const canReview = permissions.verdicts.length > 0;
  const pendingReview = canReview && draft.comments.length > 0;
  const canOpenThread = agent.threads.length > 0 || agent.canAsk;
  const threadLabel = agent.threads.length ? "Continue thread" : "Work on PR";
  const primaryLabel = pendingReview ? `Submit review · ${draft.comments.length}` : threadLabel;
  const chooseThread = agent.threads.length > 1;
  const agentActions = agent.actions.filter((action) => action.task !== "ask");
  const open = (mode: "review" | "comment") =>
    navigation.navigate("PullRequestReview", { ...props.params, mode });
  const primaryPress = () => (pendingReview ? open("review") : agent.start("ask"));
  const threadMenuItems = agent.threadActions("ask");
  const openFiles =
    props.onOpenFiles ?? (() => navigation.navigate("PullRequestFiles", props.params));
  if (!props.pr) return null;
  const primaryDisabled = pendingReview ? false : agent.disabled;
  const showPrimary = pendingReview || canOpenThread;
  // Match the native phone tab controls; the side rail keeps intrinsic sizing.
  const controlSize = verticalControls ? undefined : 60;
  // Reserve the native outer margins, custom-button padding, and item gaps.
  // UIKit needs this space to keep every action out of its overflow menu.
  // Duo's side rail uses an intrinsic icon item instead.
  const sideControls = Number(agent.canAsk) + 1;
  const primaryWidth = verticalControls
    ? undefined
    : Math.max(
        0,
        (columnMetrics?.width ?? frame.width - insets.left - insets.right) -
          58 -
          sideControls * (60 + 10 + 16),
      );
  if (Platform.OS === "android") {
    const primary = (
      <MaterialButton
        label={primaryLabel}
        tone="contrast"
        fullWidth
        disabled={primaryDisabled}
        onPress={primaryPress}
      />
    );
    return (
      <View
        className="flex-row items-center justify-between gap-3 border-t border-border-subtle bg-screen px-4 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 8) }}
      >
        {agent.canAsk ? (
          <ControlPillMenu
            title="AI helpers"
            actions={agentActions.map((action) => agent.menuAction(action.task))}
            onPressAction={({ nativeEvent }) => agent.select(nativeEvent.event)}
          >
            <View pointerEvents="none">
              <MaterialIconButton
                icon="sparkles"
                accessibilityLabel="PR agent actions"
                disabled={agent.disabled}
              />
            </View>
          </ControlPillMenu>
        ) : null}
        {showPrimary ? (
          <View className="min-w-0 flex-1">
            {!pendingReview && chooseThread ? (
              <ControlPillMenu
                title="Open thread"
                actions={threadMenuItems}
                onPressAction={({ nativeEvent }) => agent.select(nativeEvent.event)}
              >
                <View pointerEvents="none">{primary}</View>
              </ControlPillMenu>
            ) : (
              primary
            )}
          </View>
        ) : null}
        <MaterialIconButton
          icon="doc.on.doc"
          accessibilityLabel="Changed files"
          onPress={openFiles}
        />
      </View>
    );
  }
  const nativeThreadItems = threadMenuItems.map((item) => (
    <NativeHeaderToolbar.MenuAction
      key={item.id}
      icon={item.image}
      subtitle={"subtitle" in item ? item.subtitle : undefined}
      disabled={"attributes" in item && item.attributes.disabled}
      onPress={() => agent.select(item.id)}
    >
      <NativeHeaderToolbar.Label>{item.title}</NativeHeaderToolbar.Label>
    </NativeHeaderToolbar.MenuAction>
  ));
  const primaryControl = showPrimary ? (
    !pendingReview && chooseThread ? (
      <NativeHeaderToolbar.Menu
        identifier="pull-request-primary-action"
        title={primaryLabel}
        accessibilityLabel={primaryLabel}
        variant="prominent"
        width={primaryWidth}
        height={controlSize}
        icon={
          verticalControls
            ? pendingReview
              ? "text.bubble"
              : "bubble.left.and.bubble.right"
            : undefined
        }
        tintColor={colors["--color-foreground"]}
        disabled={primaryDisabled}
        separateBackground
      >
        {nativeThreadItems}
      </NativeHeaderToolbar.Menu>
    ) : (
      <NativeHeaderToolbar.Button
        identifier="pull-request-primary-action"
        label={primaryLabel}
        accessibilityLabel={primaryLabel}
        variant="prominent"
        width={primaryWidth}
        height={controlSize}
        icon={
          verticalControls
            ? pendingReview
              ? "text.bubble"
              : "bubble.left.and.bubble.right"
            : undefined
        }
        tintColor={colors["--color-foreground"]}
        disabled={primaryDisabled}
        onPress={primaryPress}
        separateBackground
      />
    )
  ) : null;
  const agentControl = agent.canAsk ? (
    <NativeHeaderToolbar.Menu
      identifier="pull-request-agent"
      width={controlSize}
      height={controlSize}
      icon="sparkles"
      title="AI helpers"
      accessibilityLabel="PR agent actions"
      disabled={agent.disabled}
      separateBackground
    >
      {agentActions.map((action) =>
        chooseThread && !action.disabled ? (
          <NativeHeaderToolbar.Menu key={action.task} title={action.title} icon={action.icon}>
            {agent.threadActions(action.task).map((item) => (
              <NativeHeaderToolbar.MenuAction
                key={item.id}
                icon={item.image}
                subtitle={"subtitle" in item ? item.subtitle : undefined}
                disabled={"attributes" in item && item.attributes.disabled}
                onPress={() => agent.select(item.id)}
              >
                <NativeHeaderToolbar.Label>{item.title}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ))}
          </NativeHeaderToolbar.Menu>
        ) : (
          <NativeHeaderToolbar.MenuAction
            key={action.task}
            icon={action.icon}
            disabled={action.disabled}
            onPress={() => agent.start(action.task)}
          >
            <NativeHeaderToolbar.Label>{action.title}</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
        ),
      )}
    </NativeHeaderToolbar.Menu>
  ) : null;
  const filesControl = (
    <NativeHeaderToolbar.Button
      identifier="workspace-trailing-action"
      width={controlSize}
      height={controlSize}
      icon="document.on.document"
      accessibilityLabel="Changed files"
      onPress={openFiles}
      separateBackground
    />
  );
  return (
    <NativeHeaderToolbar placement="bottom">
      {verticalControls ? filesControl : agentControl}
      {verticalControls ? agentControl : primaryControl}
      {verticalControls ? primaryControl : filesControl}
    </NativeHeaderToolbar>
  );
}
