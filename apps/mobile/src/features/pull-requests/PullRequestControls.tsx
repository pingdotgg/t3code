import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import Animated from "react-native-reanimated";
import { PR_ROW_LAYOUT } from "./pullRequestAnimations";
import { useNavigation } from "@react-navigation/native";
import type { PullRequestDetail } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Toolbar } from "../../components/ui/Toolbar";
import { Menu } from "../../components/ui/Menu";
import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { createNativeHeaderMenu } from "../../components/ui/nativeHeaderMenu.ios";

import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

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

/** The Duo's vertical bar, where this toolbar and the screen's bar share one column of buttons. */
export function usePullRequestVerticalControls() {
  const nativeMetrics = useNativeLayoutMetrics();
  return nativeMetrics !== null && nativeMetrics.verticalBarEdge !== "none";
}

export function PullRequestActionToolbar(props: {
  readonly pr: PullRequestDetail | null;
  readonly params: PullRequestParams;
  readonly filePath?: string;
  /** The screen's actions menu; the vertical bar shows it here with the toolbar's tools. */
  readonly menu: AppBarMenu;
  readonly onOpenFiles?: () => void;
  readonly onHeightChange?: (height: number) => void;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const { draft } = usePullRequestReviewDraft(props.params);
  const { themeVariables: colors } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const verticalControls = usePullRequestVerticalControls();
  const permissions = usePullRequestPermissions(props.params, props.pr);
  const agent = usePullRequestAgentActions(props.params, props.pr, props.filePath);
  const canReview = permissions.verdicts.length > 0;
  const pendingReview = canReview && draft.comments.length > 0;
  const showAgentControls = agent.canAsk || !permissions.connected;
  const canOpenThread = agent.threads.length > 0 || showAgentControls;
  const term = changeRequestTermKind(
    sourceControlClients.get((props.pr ?? props.params.initialSummary)?.provider).changeRequest,
  );
  const threadLabel = agent.threads.length
    ? gt("Continue thread")
    : gt("Work on {term, select, mr {MR} cr {change request} other {PR}}", { term });
  const primaryLabel = pendingReview
    ? gt("Submit review · {count}", { count: draft.comments.length })
    : threadLabel;
  const agentActionsLabel = gt(
    "{term, select, mr {MR} cr {change request} other {PR}} agent actions",
    { term },
  );
  const chooseThread = agent.chooseThread;
  const agentActions = agent.actions.filter((action) => action.task !== "ask");
  const open = (mode: "review" | "comment") =>
    navigation.navigate("PullRequestReview", { ...props.params, mode });
  const primaryPress = () => (pendingReview ? open("review") : agent.start("ask"));
  const threadMenuItems = agent.threadActions("ask");
  const openFiles =
    props.onOpenFiles ?? (() => navigation.navigate("PullRequestFiles", props.params));
  if (!props.pr)
    return verticalControls ? (
      <Toolbar placement="bottom">{createNativeHeaderMenu(props.menu)}</Toolbar>
    ) : null;
  const primaryDisabled = pendingReview ? false : agent.disabled;
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
                title={gt("AI helpers")}
                actions={agentActions.map((action) => agent.menuAction(action.task))}
                onPressAction={({ nativeEvent }) => agent.select(nativeEvent.event)}
              >
                <View pointerEvents="none">
                  <IconButton
                    icon="ellipsis.bubble"
                    accessibilityLabel={agentActionsLabel}
                    disabled={agent.disabled}
                  />
                </View>
              </Menu>
            ) : null}
            {showPrimary ? (
              <View className="min-w-0 shrink">
                {!pendingReview && chooseThread ? (
                  <Menu
                    title={gt("Open thread")}
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
            <IconButton
              icon="file.diff"
              accessibilityLabel={gt("Changed files")}
              onPress={openFiles}
            />
          </View>
        </Toolbar>
      </View>
    );
  }
  const primaryControl = showPrimary ? (
    !pendingReview && chooseThread ? (
      <Toolbar.Menu
        identifier="pull-request-primary-action"
        title={primaryLabel}
        accessibilityLabel={primaryLabel}
        variant="prominent"
        icon={
          verticalControls
            ? pendingReview
              ? "text.bubble"
              : "bubble.left.and.bubble.right"
            : undefined
        }
        tintColor={colors["--color-prominent-action"]}
        disabled={primaryDisabled}
        separateBackground
      >
        {renderThreadMenuItems(threadMenuItems, agent.select)}
      </Toolbar.Menu>
    ) : (
      <Toolbar.Button
        identifier="pull-request-primary-action"
        label={primaryLabel}
        accessibilityLabel={primaryLabel}
        variant="prominent"
        icon={
          verticalControls
            ? pendingReview
              ? "text.bubble"
              : "bubble.left.and.bubble.right"
            : undefined
        }
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
      icon="ellipsis.bubble"
      title={gt("AI helpers")}
      accessibilityLabel={agentActionsLabel}
      disabled={agent.disabled}
      separateBackground
    >
      {agentActions.map((action) =>
        chooseThread && !action.disabled ? (
          <Toolbar.Menu key={action.task} title={action.title} icon={action.icon}>
            {renderThreadMenuItems(agent.threadActions(action.task), agent.select)}
          </Toolbar.Menu>
        ) : (
          <Toolbar.MenuAction
            key={action.task}
            icon={action.icon}
            disabled={action.disabled}
            onPress={() => agent.start(action.task)}
          >
            <Toolbar.Label>{action.title}</Toolbar.Label>
          </Toolbar.MenuAction>
        ),
      )}
    </Toolbar.Menu>
  ) : null;
  const filesControl = (
    <Toolbar.Button
      identifier="workspace-trailing-action"
      icon={{ type: "image", source: require("../../../assets/icons/file-diff.png") }}
      accessibilityLabel={gt("Changed files")}
      onPress={openFiles}
      separateBackground
    />
  );
  // The vertical bar never overflows into a menu, and with a Live Activity it fits about three
  // buttons above the workspace tabs: back, the primary action and one menu.
  if (verticalControls)
    return (
      <Toolbar placement="bottom">
        {primaryControl}
        {createNativeHeaderMenu({
          ...props.menu,
          items: [
            {
              id: "changed-files",
              title: gt("Changed files"),
              icon: "doc.text.magnifyingglass",
              onPress: openFiles,
            },
            ...(showAgentControls
              ? [
                  {
                    id: "ai-helpers",
                    title: gt("AI helpers"),
                    icon: "ellipsis.bubble",
                    items: agentActions.map((action): AppBarMenuItem =>
                      chooseThread && !action.disabled
                        ? {
                            id: action.task,
                            title: action.title,
                            icon: action.icon,
                            items: appBarThreadMenuItems(
                              agent.threadActions(action.task),
                              agent.select,
                            ),
                          }
                        : {
                            id: action.task,
                            title: action.title,
                            icon: action.icon,
                            disabled: action.disabled || agent.disabled,
                            onPress: () => agent.start(action.task),
                          },
                    ),
                  },
                ]
              : []),
            ...props.menu.items,
          ],
        })}
      </Toolbar>
    );
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

function appBarThreadMenuItems(
  items: MenuAction[],
  select: (id: string) => void,
): ReadonlyArray<AppBarMenuItem> {
  return items.map((item) =>
    item.subactions
      ? {
          id: item.id ?? item.title,
          title: item.title,
          icon: item.image,
          items: appBarThreadMenuItems(item.subactions, select),
        }
      : {
          id: item.id ?? item.title,
          title: item.title,
          icon: item.image,
          subtitle: item.subtitle,
          disabled: item.attributes?.disabled,
          onPress: () => item.id && select(item.id),
        },
  );
}

function renderThreadMenuItems(items: MenuAction[], select: (id: string) => void): ReactNode {
  return items.map((item) =>
    item.subactions ? (
      <Toolbar.Menu key={item.id} title={item.title} icon={item.image}>
        {renderThreadMenuItems(item.subactions, select)}
      </Toolbar.Menu>
    ) : (
      <Toolbar.MenuAction
        key={item.id}
        icon={item.image}
        subtitle={item.subtitle}
        disabled={item.attributes?.disabled}
        onPress={() => item.id && select(item.id)}
      >
        <Toolbar.Label>{item.title}</Toolbar.Label>
      </Toolbar.MenuAction>
    ),
  );
}
