import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import Animated from "react-native-reanimated";
import { PR_ROW_LAYOUT } from "./pullRequestAnimations";
import { useNavigation } from "@react-navigation/native";
import type { PullRequestDetail } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Toolbar } from "../../components/ui/Toolbar";
import { Menu } from "../../components/ui/Menu";

import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";
import type { PullRequestAgentTask } from "./pullRequestAgentTasks";

export function PullRequestCardGroup(props: { readonly children: ReactNode }) {
  return (
    <Animated.View
      layout={PR_ROW_LAYOUT}
      className="overflow-hidden rounded-[22px] border border-composer-border border-continuous bg-grouped-card"
    >
      {props.children}
    </Animated.View>
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

type PullRequestActionToolbarProps = {
  readonly pr: PullRequestDetail | null;
  readonly params: PullRequestParams;
  readonly filePath?: string;
  readonly onOpenFiles?: () => void;
  readonly showFiles?: boolean;
  readonly onHeightChange?: (height: number) => void;
};

function useVerticalPullRequestRail() {
  const metrics = useNativeLayoutMetrics();
  return Platform.OS === "ios" && metrics !== null && metrics.verticalBarEdge !== "none";
}

function pullRequestThreadMenuItems(
  agent: ReturnType<typeof usePullRequestAgentActions>,
  task: PullRequestAgentTask,
) {
  return agent.threadActions(task).map((item) => (
    <Toolbar.MenuAction
      key={item.id}
      icon={item.image}
      subtitle={"subtitle" in item ? item.subtitle : undefined}
      disabled={agent.disabled || ("attributes" in item && item.attributes.disabled)}
      onPress={() => agent.select(item.id)}
    >
      <Toolbar.Label>{item.title}</Toolbar.Label>
    </Toolbar.MenuAction>
  ));
}

function pullRequestAgentMenuItems(agent: ReturnType<typeof usePullRequestAgentActions>) {
  return agent.actions
    .filter((action) => action.task !== "ask")
    .map((action) =>
      agent.threads.length > 1 && !action.disabled ? (
        <Toolbar.Menu key={action.task} title={action.title} icon={action.icon}>
          {pullRequestThreadMenuItems(agent, action.task)}
        </Toolbar.Menu>
      ) : (
        <Toolbar.MenuAction
          key={action.task}
          icon={action.icon}
          disabled={agent.disabled || action.disabled}
          onPress={() => agent.start(action.task)}
        >
          <Toolbar.Label>{action.title}</Toolbar.Label>
        </Toolbar.MenuAction>
      ),
    );
}

type PullRequestHeaderToolbarProps = {
  readonly pr: PullRequestDetail | null;
  readonly params: PullRequestParams;
  readonly filePath?: string;
  readonly title: string;
  readonly accessibilityLabel?: string;
  readonly onOpenComments: () => void;
  readonly commentsInHorizontalBar?: boolean;
  readonly controls?: ReadonlyArray<ReactNode>;
  readonly railMenuItems?: ReactNode;
  readonly children?: ReactNode;
};

function pullRequestHeaderMenu(props: PullRequestHeaderToolbarProps, actions?: ReactNode) {
  return (
    <Toolbar.Menu
      title={props.title}
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      icon="ellipsis"
      identifier="pull-request-more-actions"
    >
      {actions}
      {props.children}
    </Toolbar.Menu>
  );
}

export function PullRequestHeaderToolbar(props: PullRequestHeaderToolbarProps) {
  const vertical = useVerticalPullRequestRail();
  return vertical ? (
    <PullRequestVerticalHeaderToolbar {...props} />
  ) : (
    <Toolbar placement="right">
      {props.controls}
      {props.commentsInHorizontalBar !== false ? (
        <Toolbar.Button
          icon="text.bubble"
          accessibilityLabel="Comments"
          onPress={props.onOpenComments}
        />
      ) : null}
      {pullRequestHeaderMenu(props)}
    </Toolbar>
  );
}

function PullRequestVerticalHeaderToolbar(props: PullRequestHeaderToolbarProps) {
  const navigation = useNavigation();
  const draft = usePullRequestReviewDraft(props.params);
  const permissions = usePullRequestPermissions(props.params, props.pr);
  const agent = usePullRequestAgentActions(props.params, props.pr, props.filePath);
  const { themeVariables: colors } = useAppearancePreferences();
  const pendingReview =
    props.pr !== null &&
    permissions.verdicts.length > 0 &&
    (draft.comments.length > 0 || Boolean(draft.pendingReviewId));
  const showAgentControls = props.pr !== null && (agent.canAsk || !permissions.connected);
  const canOpenThread = props.pr !== null && (agent.threads.length > 0 || showAgentControls);
  const { shortLabel } = sourceControlClients.get(
    (props.pr ?? props.params.initialSummary)?.provider,
  ).changeRequest;
  const threadLabel = agent.threads.length ? "Continue thread" : `Work on ${shortLabel}`;
  const submitLabel = `Submit review${draft.comments.length ? ` · ${draft.comments.length}` : ""}`;
  const actions = (
    <>
      {canOpenThread ? (
        agent.threads.length > 1 ? (
          <Toolbar.Menu
            title={threadLabel}
            icon="bubble.left.and.bubble.right"
            disabled={agent.disabled}
          >
            {pullRequestThreadMenuItems(agent, "ask")}
          </Toolbar.Menu>
        ) : (
          <Toolbar.MenuAction
            icon="bubble.left.and.bubble.right"
            disabled={agent.disabled}
            onPress={() => agent.start("ask")}
          >
            <Toolbar.Label>{threadLabel}</Toolbar.Label>
          </Toolbar.MenuAction>
        )
      ) : null}
      {showAgentControls ? (
        <Toolbar.Menu title="AI helpers" icon="sparkles" disabled={agent.disabled}>
          {pullRequestAgentMenuItems(agent)}
        </Toolbar.Menu>
      ) : null}
      {props.railMenuItems}
    </>
  );
  return (
    <Toolbar placement="right">
      {/* UIKit places trailing items from the edge inward, reversing the vertical order. */}
      {pendingReview ? (
        <Toolbar.Button
          identifier="pull-request-primary-action"
          label={submitLabel}
          accessibilityLabel={submitLabel}
          icon="text.bubble"
          variant="prominent"
          tintColor={colors["--color-prominent-action"]}
          disabled={draft.busy}
          onPress={() =>
            navigation.navigate("PullRequestReview", { ...props.params, mode: "review" })
          }
          separateBackground
          visibilityPriority="high"
        />
      ) : null}
      {pullRequestHeaderMenu(props, actions)}
      <Toolbar.Button
        identifier="pull-request-comments"
        icon="text.bubble"
        accessibilityLabel="Comments"
        onPress={props.onOpenComments}
        separateBackground
        visibilityPriority="high"
      />
    </Toolbar>
  );
}

export function PullRequestActionToolbar(props: PullRequestActionToolbarProps) {
  const vertical = useVerticalPullRequestRail();
  return vertical ? null : <PullRequestHorizontalActionToolbar {...props} />;
}

function PullRequestHorizontalActionToolbar(props: PullRequestActionToolbarProps) {
  const navigation = useNavigation();
  const { comments, pendingReviewId, busy: draftBusy } = usePullRequestReviewDraft(props.params);
  const { themeVariables: colors } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const permissions = usePullRequestPermissions(props.params, props.pr);
  const agent = usePullRequestAgentActions(props.params, props.pr, props.filePath);
  const canReview = permissions.verdicts.length > 0;
  const pendingReview = canReview && (comments.length > 0 || Boolean(pendingReviewId));
  const showAgentControls = agent.canAsk || !permissions.connected;
  const canOpenThread = agent.threads.length > 0 || showAgentControls;
  const { shortLabel } = sourceControlClients.get(
    (props.pr ?? props.params.initialSummary)?.provider,
  ).changeRequest;
  const threadLabel = agent.threads.length ? "Continue thread" : `Work on ${shortLabel}`;
  const primaryLabel = pendingReview
    ? `Submit review${comments.length ? ` · ${comments.length}` : ""}`
    : threadLabel;
  const chooseThread = agent.threads.length > 1;
  const agentActions = agent.actions.filter((action) => action.task !== "ask");
  const open = (mode: "review" | "comment") =>
    navigation.navigate("PullRequestReview", { ...props.params, mode });
  const primaryPress = () => (pendingReview ? open("review") : agent.start("ask"));
  const threadMenuItems = agent.threadActions("ask");
  const openFiles =
    props.onOpenFiles ?? (() => navigation.navigate("PullRequestFiles", props.params));
  if (!props.pr) return null;
  const primaryDisabled = pendingReview ? draftBusy : agent.disabled;
  const showPrimary = pendingReview || canOpenThread;
  if (Platform.OS === "android") {
    const primary = (
      <Button
        label={primaryLabel}
        tone="primary"
        disabled={primaryDisabled}
        onPress={primaryPress}
      />
    );
    return (
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 bottom-0 z-10 items-center px-4 pt-2"
        style={{ paddingBottom: insets.bottom + 16 }}
        onLayout={(event) => props.onHeightChange?.(event.nativeEvent.layout.height)}
      >
        <Toolbar>
          <View className="flex-row items-center gap-2">
            {showAgentControls ? (
              <Menu
                title="AI helpers"
                actions={agentActions.map((action) => agent.menuAction(action.task))}
                onPressAction={({ nativeEvent }) => agent.select(nativeEvent.event)}
              >
                <View pointerEvents="none">
                  <IconButton
                    icon="sparkles"
                    accessibilityLabel={`${shortLabel} agent actions`}
                    disabled={agent.disabled}
                  />
                </View>
              </Menu>
            ) : null}
            {showPrimary ? (
              <View className="min-w-0 shrink">
                {!pendingReview && chooseThread ? (
                  <Menu
                    title="Open thread"
                    actions={threadMenuItems}
                    onPressAction={({ nativeEvent }) => agent.select(nativeEvent.event)}
                  >
                    <View pointerEvents="none">{primary}</View>
                  </Menu>
                ) : (
                  primary
                )}
              </View>
            ) : null}
            {props.showFiles !== false ? (
              <IconButton icon="file.diff" accessibilityLabel="Changed files" onPress={openFiles} />
            ) : null}
          </View>
        </Toolbar>
      </View>
    );
  }
  const nativeThreadItems = pullRequestThreadMenuItems(agent, "ask");
  const primaryControl = showPrimary ? (
    !pendingReview && chooseThread ? (
      <Toolbar.Menu
        identifier="pull-request-primary-action"
        title={primaryLabel}
        accessibilityLabel={primaryLabel}
        variant="prominent"
        tintColor={colors["--color-prominent-action"]}
        disabled={primaryDisabled}
        separateBackground
      >
        {nativeThreadItems}
      </Toolbar.Menu>
    ) : (
      <Toolbar.Button
        identifier="pull-request-primary-action"
        label={primaryLabel}
        accessibilityLabel={primaryLabel}
        variant="prominent"
        tintColor={colors["--color-prominent-action"]}
        disabled={primaryDisabled}
        onPress={primaryPress}
        separateBackground
      />
    )
  ) : null;
  const agentControl = showAgentControls ? (
    <Toolbar.Menu
      identifier="pull-request-agent"
      icon="sparkles"
      title="AI helpers"
      accessibilityLabel={`${shortLabel} agent actions`}
      disabled={agent.disabled}
      separateBackground
    >
      {pullRequestAgentMenuItems(agent)}
    </Toolbar.Menu>
  ) : null;
  // Tabler file-diff geometry, rasterized at 1x/2x/3x for UIKit template images.
  const filesControl =
    props.showFiles !== false ? (
      <Toolbar.Button
        identifier="workspace-trailing-action"
        icon={{ type: "image", source: require("../../../assets/icons/file-diff.png") }}
        accessibilityLabel="Changed files"
        onPress={openFiles}
        separateBackground
      />
    ) : null;
  return (
    <Toolbar placement="bottom">
      {agentControl}
      <Toolbar.Spacer flexible />
      {primaryControl}
      <Toolbar.Spacer flexible />
      {filesControl}
    </Toolbar>
  );
}
