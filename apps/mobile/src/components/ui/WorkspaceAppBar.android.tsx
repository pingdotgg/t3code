import { Box, Icon, IconButton, RNHostView } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import type { MenuAction } from "@react-native-menu/menu";
import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Pressable, View } from "react-native";

import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import { AndroidHeaderIconButton } from "./AndroidScreenHeader";
import { AppText } from "./AppText";
import { NativeAppBar } from "./NativeAppBar.android";
import { useControlTheme } from "./useControlTheme";
import { useToolbarLayout } from "./useToolbarLayout";

const SEARCH_ICON = require("../../../assets/icons/search.xml");
const FILTER_ICON = require("../../../assets/icons/filter.xml");
const FILTER_FILLED_ICON = require("../../../assets/icons/filter-filled.xml");
// Material TopAppBar: 48dp icon buttons, the last one 4dp from the end.
const ACTION_SIZE = 48;
const ACTION_END_INSET = 4;

export interface WorkspaceAppBarProps {
  readonly title: string;
  readonly titleContent?: ReactNode;
  readonly search?: {
    readonly accessibilityLabel: string;
    readonly active: boolean;
    readonly field: ReactNode;
    readonly onOpen: () => void;
    readonly onClose: () => void;
  };
  /** Stays trailing while searching, so it never moves and still narrows the results. */
  readonly filter?: {
    readonly accessibilityLabel: string;
    readonly customized: boolean;
    readonly actions: MenuAction[];
    readonly onSelect: (id: string) => void;
  };
}

function createWorkspaceAppBarStore() {
  let owner: object | null = null;
  let content: WorkspaceAppBarProps | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => content,
    set: (nextOwner: object, next: WorkspaceAppBarProps) => {
      owner = nextOwner;
      content = next;
      emit();
    },
    clear: (previousOwner: object) => {
      if (owner !== previousOwner) return;
      owner = null;
      content = null;
      emit();
    },
  };
}

const WorkspaceAppBarStoreContext = createContext<ReturnType<
  typeof createWorkspaceAppBarStore
> | null>(null);

/**
 * Hosts one app bar above a set of workspace tab panes. Hidden panes lay out at zero size, and a
 * Compose bar inside one takes frames to measure again when it returns, so the bar lives here and
 * the visible tab projects its contents into it.
 */
export function WorkspaceAppBarScope(props: {
  readonly children: ReactNode;
  /** Off, panes draw their own bars; the children keep their place so toggling keeps their state. */
  readonly enabled?: boolean;
}) {
  const [store] = useState(createWorkspaceAppBarStore);
  const enabled = props.enabled ?? true;
  return (
    <WorkspaceAppBarStoreContext value={enabled ? store : null}>
      {enabled ? <WorkspaceAppBarHost /> : null}
      {props.children}
    </WorkspaceAppBarStoreContext>
  );
}

function WorkspaceAppBarHost() {
  const store = use(WorkspaceAppBarStoreContext)!;
  const content = useSyncExternalStore(store.subscribe, store.get, store.get);
  return <WorkspaceAppBarView {...(content ?? { title: "" })} />;
}

export function useHasWorkspaceAppBar() {
  return use(WorkspaceAppBarStoreContext) !== null;
}

/** Shows a tab's header in the enclosing scope's bar, or inline outside one. */
export function WorkspaceAppBar(props: WorkspaceAppBarProps) {
  const store = use(WorkspaceAppBarStoreContext);
  const [owner] = useState(() => ({}));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- projects this tab's header into the out-of-tree workspace bar after every commit
  useLayoutEffect(() => {
    store?.set(owner, props);
  });
  // Hidden panes destroy their effects, so the tab leaving the screen releases the bar.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the workspace bar when this tab hides or unmounts
  useLayoutEffect(() => (store ? () => store.clear(owner) : undefined), [store, owner]);
  return store ? null : <WorkspaceAppBarView {...props} />;
}

/**
 * Every tab draws the same bar, so a switch only changes its contents. The actions are Compose nodes
 * and the title host keeps one height: React Native content hosted in Compose lags Compose's layout
 * by a frame whenever its size changes, which showed as the filter jumping between tabs.
 */
function WorkspaceAppBarView(props: WorkspaceAppBarProps) {
  const { search, filter } = props;
  const searching = search?.active === true;
  const { colors } = useControlTheme();
  const tint = colors["--color-header-foreground"];
  const { height, paddingTop, paddingBottom } = useToolbarLayout();
  const filterMenu = filter ? (
    <AndroidAnchoredMenu
      actions={filter.actions}
      onPressAction={({ nativeEvent }) => filter.onSelect(nativeEvent.event)}
    >
      {(open) =>
        searching ? (
          <AndroidHeaderIconButton
            accessibilityLabel={filter.accessibilityLabel}
            icon={
              filter.customized
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            onPress={open}
          />
        ) : (
          // The bar draws the icon; this takes the touch so the menu can anchor to the slot.
          <Pressable
            accessibilityLabel={filter.accessibilityLabel}
            accessibilityRole="button"
            android_ripple={{ borderless: true, radius: 20 }}
            onPress={open}
            style={{ width: ACTION_SIZE, height: ACTION_SIZE }}
          />
        )
      }
    </AndroidAnchoredMenu>
  ) : null;
  return (
    <View className="bg-header" style={{ paddingTop, paddingBottom }}>
      <View
        pointerEvents={searching ? "none" : "auto"}
        accessibilityElementsHidden={searching}
        importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
        style={{ opacity: searching ? 0 : 1 }}
      >
        <NativeAppBar
          title={
            <RNHostView matchContents={{ vertical: true }}>
              <View collapsable={false} className="justify-center" style={{ height: ACTION_SIZE }}>
                {props.titleContent ?? (
                  <AppText textRole="title" numberOfLines={1} className="text-header-foreground">
                    {props.title}
                  </AppText>
                )}
              </View>
            </RNHostView>
          }
          // Both slots always exist: Expo UI applies a child insert or removal a frame before the
          // other children's new props, so changing the slot count drew the wrong glyph mid-switch.
          nativeActions={
            <>
              <IconButton enabled={search !== undefined} onClick={search?.onOpen}>
                <Icon
                  source={SEARCH_ICON}
                  size={24}
                  tint={search ? tint : "transparent"}
                  contentDescription={search?.accessibilityLabel}
                />
              </IconButton>
              <Box contentAlignment="center" modifiers={[size(ACTION_SIZE, ACTION_SIZE)]}>
                <Icon
                  source={filter?.customized ? FILTER_FILLED_ICON : FILTER_ICON}
                  size={24}
                  tint={filter ? tint : "transparent"}
                />
              </Box>
            </>
          }
        />
        {filter && !searching ? (
          <View
            className="absolute"
            style={{ right: ACTION_END_INSET, top: (height - ACTION_SIZE) / 2 }}
          >
            {filterMenu}
          </View>
        ) : null}
      </View>
      {searching ? (
        <View
          className="absolute inset-0 bg-header"
          style={{ paddingTop, paddingBottom, paddingHorizontal: ACTION_END_INSET }}
        >
          <View className="flex-1 flex-row items-center gap-1">
            <AndroidHeaderIconButton
              accessibilityLabel="Close search"
              icon="arrow.left"
              onPress={search.onClose}
            />
            {search.field}
            {filterMenu}
          </View>
        </View>
      ) : null}
    </View>
  );
}
