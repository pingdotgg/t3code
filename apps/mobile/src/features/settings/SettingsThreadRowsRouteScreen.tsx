import { useAtomValue } from "@effect/atom-react";
import {
  MOBILE_DEFAULT_STORED_LAYOUT,
  insertSidebarRowSpacer,
  isDefaultSidebarRowLayout,
  resolveSidebarRowLayout,
  setSidebarRowLineKept,
  storedSidebarRowLayout,
  withoutSidebarRowItem,
  type SidebarRowLayout,
} from "@t3tools/client-runtime/thread-row-layout";
import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { presentThreadPr } from "../../state/thread-pr-presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ThreadRowLines,
  useThreadRowMetrics,
  type ThreadRowItemContent,
} from "../threads/thread-list-v2-items";
import { THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME } from "../threads/thread-list-v2-row-appearance";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { ThreadRowLayoutLanes } from "./ThreadRowLayoutLanes";

const SAMPLE_ENVIRONMENT_ID = EnvironmentId.make("thread-rows-sample");
const SAMPLE_NOW = Date.parse("2026-01-02T12:00:00Z");
const HOUR = 3_600_000;

/** The built-in sample threads: one with every item, one with only a project and a title. */
function useSampleContent() {
  const gt = useGT();
  const m = useMessages();
  const metrics = useThreadRowMetrics();
  const title = gt("Add dynamic workflows to mobile", { $context: "sample thread title" });
  const full: ThreadRowItemContent = {
    environmentId: SAMPLE_ENVIRONMENT_ID,
    title,
    titleClassName: "text-base font-t3-medium text-foreground",
    project: {
      title: "t3code",
      projectIcon: { kind: "monogram", text: "T3", color: "blue" },
      workspaceRoot: null,
      faviconPath: null,
    },
    branch: "t3/mobile-workflows",
    issues: [{ displayKey: "#41" }, { displayKey: "#42" }],
    pr: presentThreadPr(
      {
        number: 18642,
        title,
        url: "https://example.com/pull/18642",
        baseRef: "main",
        headRef: "t3/mobile-workflows",
        state: "merged",
      },
      null,
      m,
    ),
    environmentLabel: gt("Studio Mac", { $context: "sample machine name" }),
    environmentMachine: "laptop",
    agents: {
      instance: {
        driverKind: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        showBadge: false,
      },
      drivers: ["claudeAgent", "codex", "codex"],
      iconUrl: null,
      nameLabel: null,
    },
    timeLabel: relativeTime(new Date(SAMPLE_NOW - 3 * HOUR).toISOString(), SAMPLE_NOW, m),
    metrics,
    tone: {
      text: "text-foreground-tertiary",
      icon: "accent-foreground-tertiary",
      mutedIcon: "accent-foreground-muted",
      time: "text-foreground-tertiary",
      providerSurfaceColor: undefined,
    },
  };
  const sparse: ThreadRowItemContent = {
    ...full,
    title: gt("Quick question about the sidebar", { $context: "sample thread title" }),
    branch: null,
    issues: undefined,
    pr: null,
    environmentLabel: null,
    agents: null,
    timeLabel: relativeTime(new Date(SAMPLE_NOW - 48 * HOUR).toISOString(), SAMPLE_NOW, m),
  };
  return { full, sparse };
}

function HeightChoice(props: {
  readonly label: string;
  readonly sameHeight: boolean;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const bar = (width: number, className?: string) => (
    <View className={cn("h-1 rounded-sm", className)} style={{ width: `${width}%` }} />
  );
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "flex-1 justify-between gap-3 rounded-[22px] border-2 bg-grouped-card p-3 active:opacity-70",
        props.selected ? "border-primary" : "border-transparent",
      )}
    >
      <View className="gap-1 rounded-xl bg-screen p-2">
        <View className="gap-1 rounded-md bg-subtle px-2 py-[7px]">
          {bar(40, "bg-foreground-tertiary")}
          {bar(85, "bg-foreground-secondary")}
          {bar(65, "bg-foreground-tertiary")}
        </View>
        <View className="gap-1 rounded-md bg-subtle px-2 py-[7px]">
          {bar(40, "bg-foreground-tertiary")}
          {bar(70, "bg-foreground-secondary")}
          {/* A kept line stays empty, so this card keeps the others' height. */}
          {props.sameHeight ? bar(65) : null}
        </View>
        <View className="gap-1 rounded-md bg-subtle px-2 py-[7px]">
          {bar(40, "bg-foreground-tertiary")}
          {bar(80, "bg-foreground-secondary")}
          {bar(55, "bg-foreground-tertiary")}
        </View>
      </View>
      <View className="flex-row items-center gap-2 px-0.5">
        {props.selected ? (
          <View className="size-5 items-center justify-center rounded-full bg-primary">
            <SymbolView name="checkmark" size={12} tintColorClassName="accent-primary-foreground" />
          </View>
        ) : (
          <View className="size-5 rounded-full border-[1.5px] border-foreground-tertiary" />
        )}
        <Text
          className={cn(
            "shrink",
            props.selected
              ? "font-t3-bold text-foreground"
              : "font-t3-medium text-foreground-muted",
          )}
        >
          {props.label}
        </Text>
      </View>
    </Pressable>
  );
}

export function SettingsThreadRowsRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const save = useAtomCommand(saveMobilePreferences);
  const sample = useSampleContent();
  const [dragging, setDragging] = useState(false);
  const layout = resolveSidebarRowLayout(
    AsyncResult.isSuccess(preferences) ? (preferences.value.threadRowLayout ?? {}) : {},
    MOBILE_DEFAULT_STORED_LAYOUT,
  );
  // The thread list does not track terminals, so the preview leaves them out as the list does.
  const rowLayout = withoutSidebarRowItem(layout, "terminals");
  // Each edit reads the newest saved layout, so quick changes never undo one another.
  const edit = (change: (current: SidebarRowLayout) => SidebarRowLayout) => {
    void save({
      transform: (current) => ({
        threadRowLayout: storedSidebarRowLayout(
          change(
            resolveSidebarRowLayout(current.threadRowLayout ?? {}, MOBILE_DEFAULT_STORED_LAYOUT),
          ),
          MOBILE_DEFAULT_STORED_LAYOUT,
        ),
      }),
    });
  };
  const sameHeight = layout.keepLines.length > 0;
  const setSameHeight = (value: boolean) =>
    edit((current) =>
      setSidebarRowLineKept(setSidebarRowLineKept(current, "middle", value), "bottom", value),
    );

  return (
    <SettingsScreen title={gt("Thread rows")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        scrollEnabled={!dragging}
      >
        <SettingsSection
          title={gt("Preview", { $context: "sample of how thread rows look" })}
          trailing={
            <Text textRole="footnote" className="px-2 text-foreground-tertiary">
              {gt("Sample threads")}
            </Text>
          }
        >
          <View pointerEvents="none">
            {[sample.full, sample.sparse].map((content, index) => (
              <View
                key={content.title}
                className={cn(
                  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
                  index > 0 && "border-t border-border-subtle",
                )}
              >
                <ThreadRowLines content={content} layout={rowLayout} />
              </View>
            ))}
          </View>
        </SettingsSection>
        <SettingsSection
          title={gt("Layout", { $context: "arrangement of items in a thread row" })}
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Add spacer")}
              disabled={!ready}
              onPress={() =>
                edit(
                  (current) =>
                    insertSidebarRowSpacer(current, "bottom", Number.POSITIVE_INFINITY).layout,
                )
              }
              className="-my-4 flex-row items-center gap-1 px-2 py-4 active:opacity-60"
              style={{ opacity: ready ? 1 : 0.4 }}
            >
              <SymbolView name="plus" size={14} tintColorClassName="accent-primary-text" />
              <Text className="font-t3-medium text-primary-text">
                {gt("Spacer", { $context: "flexible empty space in a layout" })}
              </Text>
            </Pressable>
          }
          footer={gt(
            "Touch and hold an item to see its name and drag it to another line. Drag it to Hidden to hide it.",
          )}
        >
          <ThreadRowLayoutLanes
            layout={layout}
            disabled={!ready}
            edit={edit}
            sample={sample.full}
            onDragActiveChange={setDragging}
          />
        </SettingsSection>
        <View className="gap-2">
          <Text textRole="footnote" className="px-2 font-t3-medium text-foreground-muted">
            {gt("Row height")}
          </Text>
          <View className="flex-row gap-2.5">
            <HeightChoice
              label={gt("Fit each thread")}
              sameHeight={false}
              selected={!sameHeight}
              disabled={!ready}
              onPress={() => setSameHeight(false)}
            />
            <HeightChoice
              label={gt("Same height", { $context: "every thread row has the same height" })}
              sameHeight
              selected={sameHeight}
              disabled={!ready}
              onPress={() => setSameHeight(true)}
            />
          </View>
        </View>
        <View className="rounded-full bg-grouped-card">
          <Button
            label={gt("Reset to default")}
            tone="text"
            fullWidth
            disabled={!ready || isDefaultSidebarRowLayout(layout, MOBILE_DEFAULT_STORED_LAYOUT)}
            onPress={() => {
              void save({ threadRowLayout: {} });
            }}
          />
        </View>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
