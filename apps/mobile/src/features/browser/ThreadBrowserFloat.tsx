import { useIsFocused } from "@react-navigation/native";
import type { EnvironmentId, PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { browserTabTitle } from "./browserTabs";
import { PreviewStreamWebView } from "./PreviewStreamWebView";

const PLAYER_LONG_SIDE = 184;
const PLAYER_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const PLAYER_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

export function ThreadBrowserFloat(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabs: ReadonlyArray<PreviewSessionSnapshot>;
  readonly loaded: boolean;
  readonly top: number;
  readonly onOpen: (tabId: string) => void;
}) {
  const [tabId, setTabId] = useState<string | null>(null);
  const known = useRef<ReadonlyMap<string, string | undefined> | null>(null);
  useEffect(() => {
    if (!props.loaded) return;
    const previous = known.current;
    known.current = new Map(props.tabs.map((tab) => [tab.tabId, tab.revealRequest?.id]));
    // The first list is a baseline, so reopening a thread does not resurface old tabs.
    if (previous === null) return;
    const opened = props.tabs.findLast(
      (tab) =>
        tab.reveal === true &&
        (tab.revealRequest
          ? previous.get(tab.tabId) !== tab.revealRequest.id
          : !previous.has(tab.tabId)),
    );
    if (opened !== undefined) setTabId(opened.tabId);
  }, [props.loaded, props.tabs]);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  const tab = props.tabs.find((entry) => entry.tabId === tabId) ?? null;
  const onOpen = props.onOpen;
  const open = useCallback(() => {
    if (tabId === null) return;
    setTabId(null);
    onOpen(tabId);
  }, [onOpen, tabId]);
  const close = useCallback(() => setTabId(null), []);
  if (!tab || !focused) return null;
  return (
    <FloatingBrowserPlayer
      environmentId={props.environmentId}
      threadId={props.threadId}
      tab={tab}
      live={foreground}
      top={props.top}
      onOpen={open}
      onClose={close}
    />
  );
}

function FloatingBrowserPlayer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tab: PreviewSessionSnapshot;
  readonly live: boolean;
  readonly top: number;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}) {
  const { themeVariables } = useAppearancePreferences();
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  // The page keeps its own size; the player scales it into a box of the same shape.
  const aspect = Math.min(Math.max(viewport ? viewport.width / viewport.height : 16 / 10, 0.5), 2);
  const width = aspect >= 1 ? PLAYER_LONG_SIDE : Math.round(PLAYER_LONG_SIDE * aspect);
  const height = Math.round(width / aspect);
  const background = themeVariables["--color-sheet-solid"];
  return (
    <Animated.View
      entering={PLAYER_ENTERING}
      exiting={PLAYER_EXITING}
      className="absolute right-3 z-30 overflow-hidden rounded-2xl border border-border shadow-md shadow-black/20"
      style={{ top: props.top, width, height, backgroundColor: background }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open browser, ${browserTabTitle(props.tab)}`}
        accessibilityHint="Opens the browser tab full screen"
        onPress={props.onOpen}
        className="flex-1"
      >
        <View pointerEvents="none" className="flex-1">
          <PreviewStreamWebView
            environmentId={props.environmentId}
            threadId={props.threadId}
            tabId={props.tab.tabId}
            interactive={false}
            background={background}
            compact
            paused={!props.live}
            onViewport={setViewport}
            onGone={props.onClose}
          />
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close floating preview"
        hitSlop={8}
        onPress={props.onClose}
        className="absolute right-1.5 top-1.5 size-6 items-center justify-center rounded-full bg-black/55"
      >
        <SymbolView name="xmark" size={11} tintColor="#ffffff" type="monochrome" />
      </Pressable>
    </Animated.View>
  );
}
