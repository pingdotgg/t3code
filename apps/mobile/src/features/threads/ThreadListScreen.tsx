import type { OrchestrationProject, OrchestrationThread, ProjectId } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View, type View as RNView } from "react-native";
import { useColorScheme } from "react-native";
import Animated, { FadeInDown, FadeOutUp, LinearTransition } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { GlassSafeAreaView } from "../../components/GlassSafeAreaView";
import { StatusPill } from "../../components/StatusPill";
import { cx } from "../../lib/classNames";
import { sortCopy } from "../../lib/arrayCompat";
import type { RemoteClientConnectionState } from "../../lib/remoteClient";
import { relativeTime } from "../../lib/time";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { lastConversationLine, threadStatusTone } from "./threadPresentation";

export interface ThreadListScreenProps {
  readonly heroTitle: string;
  readonly showBrandWordmark: boolean;
  readonly screenTone: {
    readonly label: string;
    readonly pillClassName: string;
    readonly textClassName: string;
  };
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionPulse: boolean;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly hasClient: boolean;
  readonly hasServerConfig: boolean;
  readonly hiddenThreadId?: OrchestrationThread["id"] | null;
  readonly connectionError: string | null;
  readonly onOpenConnectionEditor: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onCreateThread: (projectId: ProjectId) => Promise<void>;
  readonly onSelectThread: (
    threadId: OrchestrationThread["id"],
    sourceFrame: TransitionSourceFrame | null,
  ) => void;
}

export interface TransitionSourceFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function T3Wordmark(props: { readonly color: string }) {
  return (
    <Svg
      accessibilityLabel="T3"
      width={36}
      height={21.5}
      viewBox="15.5309 37 94.3941 56.96"
      fill="none"
    >
      <Path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill={props.color}
      />
    </Svg>
  );
}

type GlyphName =
  | "link"
  | "stack"
  | "folder"
  | "refresh"
  | "arrow-up-right"
  | "chevron-down"
  | "chevron-up"
  | "device"
  | "spark";

const GLYPH_SYMBOL_NAMES = {
  link: "link",
  stack: "square.stack.3d.up",
  folder: "folder",
  refresh: "arrow.clockwise",
  "arrow-up-right": "arrow.up.right",
  "chevron-down": "chevron.down",
  "chevron-up": "chevron.up",
  device: "iphone",
  spark: "sparkles",
} as const;

const GLYPH_PATHS: Record<GlyphName, string> = {
  link: "M6.1 9.9 9.9 6.1M5.2 11.8H4a2.8 2.8 0 1 1 0-5.6h1.2M10.8 4.2H12a2.8 2.8 0 1 1 0 5.6h-1.2",
  stack: "M2.5 5.2 8 2.5l5.5 2.7L8 7.9 2.5 5.2ZM2.5 8 8 10.7 13.5 8M2.5 10.8 8 13.5l5.5-2.7",
  folder: "M1.8 4.5h4l1.4 1.6h7v5.7a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.5Z",
  refresh: "M13.2 5.2V2.8M13.2 2.8h-2.4M13.2 2.8 10.8 5.2M12.3 8A4.3 4.3 0 1 1 8 3.7",
  "arrow-up-right": "M5 11 11 5M6 5h5v5",
  "chevron-down": "m3.5 5.8 4.5 4.4 4.5-4.4",
  "chevron-up": "m3.5 10.2 4.5-4.4 4.5 4.4",
  device:
    "M4.2 2.5h7.6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM6.4 11.7h3.2",
  spark: "M8 2.4 9.1 6.9 13.6 8l-4.5 1.1L8 13.6 6.9 9.1 2.4 8l4.5-1.1L8 2.4Z",
};

const GLYPH_STROKE_JOIN: Partial<Record<GlyphName, "round">> = {
  folder: "round",
};

function Glyph(props: {
  readonly name: GlyphName;
  readonly color: string;
  readonly size?: number;
}) {
  const size = props.size ?? 16;
  const strokeWidth = 1.8;
  const symbolName = GLYPH_SYMBOL_NAMES[props.name];
  const path = GLYPH_PATHS[props.name];
  const strokeLinejoin = GLYPH_STROKE_JOIN[props.name] ?? "round";

  const fallback = (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d={path}
        stroke={props.color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin={strokeLinejoin}
      />
    </Svg>
  );

  return (
    <SymbolView
      name={symbolName}
      fallback={fallback}
      size={size}
      tintColor={props.color}
      type="monochrome"
      weight="medium"
    />
  );
}

function ExpandThreadsToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly palette: ReturnType<typeof makePalette>;
  readonly onPress: () => void;
}) {
  const label = props.expanded ? "Show less" : `Show ${props.hiddenCount} more`;

  return (
    <Pressable className="items-center px-1 pb-4 pt-3" onPress={props.onPress}>
      <View className="w-full flex-row items-center gap-3">
        <View className="h-px flex-1" style={{ backgroundColor: props.palette.border }} />
        <View
          className="flex-row items-center gap-2 px-3 py-2"
          style={{
            borderWidth: 1,
            borderColor: props.palette.border,
            backgroundColor: props.palette.panelAlt,
          }}
        >
          <Text
            className="text-[11px] font-bold uppercase"
            style={{ color: props.palette.muted, letterSpacing: 1.05 }}
          >
            {label}
          </Text>
          <Glyph
            name={props.expanded ? "chevron-up" : "chevron-down"}
            color={props.palette.muted}
            size={14}
          />
        </View>
        <View className="h-px flex-1" style={{ backgroundColor: props.palette.border }} />
      </View>
    </Pressable>
  );
}

function toneStyles(label: string) {
  const value = label.toLowerCase();

  if (value.includes("error") || value.includes("disconnect")) {
    return {
      dot: "bg-rose-500",
      line: "bg-rose-300/80",
      chip: "bg-rose-100/90",
      text: "text-rose-700",
    };
  }

  if (value.includes("run")) {
    return {
      dot: "bg-orange-500",
      line: "bg-orange-300/80",
      chip: "bg-orange-100/90",
      text: "text-orange-700",
    };
  }

  if (value.includes("connect") || value.includes("ready") || value.includes("start")) {
    return {
      dot: "bg-sky-500",
      line: "bg-sky-300/80",
      chip: "bg-sky-100/90",
      text: "text-sky-700",
    };
  }

  return {
    dot: "bg-slate-500",
    line: "bg-slate-300/80",
    chip: "bg-slate-200/90",
    text: "text-slate-700",
  };
}

function StatCell(props: {
  readonly icon: React.ComponentProps<typeof Glyph>["name"];
  readonly label: string;
  readonly value: string;
  readonly palette: ReturnType<typeof makePalette>;
}) {
  return (
    <View className="flex-1 gap-2">
      <View className="flex-row items-center gap-2">
        <Glyph name={props.icon} color={props.palette.muted} size={15} />
        <Text
          className="text-[11px] font-bold uppercase"
          style={{ color: props.palette.muted, letterSpacing: 1.1 }}
        >
          {props.label}
        </Text>
      </View>
      <Text
        className="text-[32px] font-extrabold leading-[34px]"
        style={{ color: props.palette.text }}
      >
        {props.value}
      </Text>
    </View>
  );
}

function ProjectActionButton(props: {
  readonly palette: ReturnType<typeof makePalette>;
  readonly label: string;
  readonly icon: React.ComponentProps<typeof Glyph>["name"];
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      className="min-h-[40px] flex-row items-center justify-center gap-2 px-3 py-2"
      style={{
        backgroundColor: props.palette.actionSecondary,
        borderWidth: 1,
        borderColor: props.palette.border,
      }}
      onPress={props.onPress}
    >
      <Glyph name={props.icon} color={props.palette.actionSecondaryText} size={16} />
      <Text
        className="text-[11px] font-extrabold uppercase"
        style={{ color: props.palette.actionSecondaryText, letterSpacing: 1.05 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ThreadRow(props: {
  readonly thread: OrchestrationThread;
  readonly isLast: boolean;
  readonly hidden?: boolean;
  readonly onPress: (sourceFrame: TransitionSourceFrame | null) => void;
  readonly palette: ReturnType<typeof makePalette>;
}) {
  const containerRef = useRef<RNView>(null);
  const threadTone = threadStatusTone(props.thread);
  const styles = toneStyles(threadTone.label);

  return (
    <Pressable
      ref={containerRef}
      className="overflow-hidden px-1 py-4"
      style={{
        borderBottomWidth: props.isLast ? 0 : 1,
        borderBottomColor: props.palette.border,
        opacity: props.hidden ? 0 : 1,
      }}
      onPress={() => {
        containerRef.current?.measureInWindow((x, y, width, height) => {
          if (width > 0 && height > 0) {
            props.onPress({ x, y, width, height });
            return;
          }
          props.onPress(null);
        });
      }}
    >
      <View className="gap-3">
        <View className="flex-row items-start gap-4">
          <View className="flex-1 gap-2">
            <View className="flex-row items-center gap-2.5">
              <View
                className={cx("h-2.5 w-2.5", styles.dot)}
                style={{ borderRadius: 2, opacity: 0.88 }}
              />
              <Animated.Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  color: props.palette.text,
                  fontSize: 18,
                  fontWeight: "800",
                  lineHeight: 22,
                }}
              >
                {props.thread.title}
              </Animated.Text>
            </View>

            <Text
              numberOfLines={2}
              className="text-[14px] leading-[20px]"
              style={{ color: props.palette.muted }}
            >
              {lastConversationLine(props.thread)}
            </Text>
          </View>

          <View className="items-end gap-2">
            <StatusPill {...threadTone} />
          </View>
        </View>

        <Text
          className="text-[11px] font-bold uppercase"
          style={{ color: props.palette.muted, letterSpacing: 1.05 }}
        >
          {props.thread.modelSelection.provider} · {props.thread.modelSelection.model} ·{" "}
          {relativeTime(props.thread.updatedAt ?? props.thread.createdAt)}
        </Text>

        <View className="h-[2px] overflow-hidden" style={{ backgroundColor: props.palette.rule }}>
          <View className={cx("h-full", styles.line)} style={{ width: "34%" }} />
        </View>
      </View>
    </Pressable>
  );
}

function SectionPanel(props: {
  readonly children: React.ReactNode;
  readonly palette: ReturnType<typeof makePalette>;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: props.palette.border,
        backgroundColor: props.palette.panel,
      }}
    >
      {props.children}
    </View>
  );
}

function orderThreadsByRecency(threads: ReadonlyArray<OrchestrationThread>) {
  return sortCopy(threads, (left, right) => {
    const leftTime = new Date(left.updatedAt ?? left.createdAt).getTime();
    const rightTime = new Date(right.updatedAt ?? right.createdAt).getTime();
    return rightTime - leftTime;
  });
}

function makePalette(isDarkMode: boolean) {
  if (isDarkMode) {
    return {
      canvas: "#11100e",
      panel: "#1a1815",
      panelAlt: "#221f1b",
      border: "rgba(255,255,255,0.08)",
      text: "#f5f1ea",
      muted: "#a69e92",
      rule: "rgba(255,255,255,0.1)",
      tabActive: "#f5f1ea",
      tabActiveText: "#171512",
      tabInactive: "#2a2723",
      tabInactiveText: "#b2ab9f",
      rail: "#201d19",
      action: "#f5f1ea",
      actionText: "#171512",
      actionSecondary: "#2b2823",
      actionSecondaryText: "#f5f1ea",
    };
  }

  return {
    canvas: "#efe7dc",
    panel: "#fbf7f1",
    panelAlt: "#f3ede3",
    border: "#d8cec1",
    text: "#1f1b17",
    muted: "#8a8175",
    rule: "#ddd2c5",
    tabActive: "#2c2a2d",
    tabActiveText: "#f8f4ee",
    tabInactive: "#ffffff",
    tabInactiveText: "#b0a79b",
    rail: "#f3ede3",
    action: "#2c2a2d",
    actionText: "#f8f4ee",
    actionSecondary: "#ffffff",
    actionSecondaryText: "#1f1b17",
  };
}

export function ThreadListScreen(props: ThreadListScreenProps) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makePalette(isDarkMode);
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(new Set());
  const groupedProjects = props.projects.map((project) => ({
    project,
    threads: props.threads.filter((thread) => thread.projectId === project.id),
  }));

  return (
    <View className="flex-1" style={{ backgroundColor: palette.canvas }}>
      <View className="absolute inset-x-0 top-0 z-20">
        <GlassSafeAreaView
          leftSlot={
            <View className="flex-row items-center gap-2">
              <T3Wordmark color={isDarkMode ? "#ffffff" : "#020617"} />
              <Text
                className="text-[16px] font-extrabold uppercase"
                style={{
                  color: isDarkMode ? "rgba(255,255,255,0.72)" : "#020617",
                  letterSpacing: 1.1,
                }}
              >
                Code
              </Text>
            </View>
          }
        />
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="overflow-hidden px-5 pb-12 pt-[132px]">
          <View className="gap-4">
            {props.connectionError ? <ErrorBanner message={props.connectionError} /> : null}

            <SectionPanel palette={palette}>
              <View className="gap-5 px-4 py-4">
                <View className="flex-row items-start justify-between gap-4">
                  <View className="flex-1 gap-2">
                    <Text
                      className="text-[11px] font-bold uppercase"
                      style={{ color: palette.muted, letterSpacing: 1.3 }}
                    >
                      Control board
                    </Text>
                  </View>

                  <View className="items-end gap-2">
                    <ConnectionStatusDot
                      state={props.connectionState}
                      pulse={props.connectionPulse}
                    />
                  </View>
                </View>

                <View className="gap-5">
                  <View className="flex-row gap-6">
                    <StatCell
                      icon="stack"
                      label="Threads"
                      value={String(props.threads.length)}
                      palette={palette}
                    />
                    <StatCell
                      icon="folder"
                      label="Projects"
                      value={String(groupedProjects.length)}
                      palette={palette}
                    />
                  </View>

                  <View className="flex-row items-center gap-2">
                    <Glyph name="device" color={palette.muted} size={14} />
                    <Text
                      className="text-[11px] font-bold uppercase"
                      style={{ color: palette.muted, letterSpacing: 1.05 }}
                    >
                      {props.hasClient ? "Connected" : "Awaiting connection"}
                    </Text>
                  </View>

                  <View className="flex-row gap-3">
                    <Pressable
                      accessibilityLabel={
                        props.hasClient ? "Edit remote link" : "Connect to server"
                      }
                      className="min-h-[52px] flex-1 flex-row items-center justify-center gap-2 px-3 py-3"
                      style={{ backgroundColor: palette.action }}
                      onPress={props.onOpenConnectionEditor}
                    >
                      <Glyph
                        name={props.hasClient ? "link" : "device"}
                        color={palette.actionText}
                        size={18}
                      />
                      <Text
                        className="text-[13px] font-extrabold uppercase"
                        style={{ color: palette.actionText, letterSpacing: 1 }}
                      >
                        {props.hasClient ? "Link" : "Connect"}
                      </Text>
                    </Pressable>

                    {props.hasClient ? (
                      <Pressable
                        accessibilityLabel="Refresh threads"
                        className="min-h-[52px] flex-1 flex-row items-center justify-center gap-2 px-3 py-3"
                        style={{
                          backgroundColor: palette.actionSecondary,
                          borderWidth: 1,
                          borderColor: palette.border,
                        }}
                        onPress={() => void props.onRefresh()}
                      >
                        <Glyph name="refresh" color={palette.actionSecondaryText} size={18} />
                        <Text
                          className="text-[13px] font-extrabold uppercase"
                          style={{ color: palette.actionSecondaryText, letterSpacing: 1 }}
                        >
                          Refresh
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              </View>
            </SectionPanel>

            {props.threads.length === 0 ? (
              <EmptyState
                title={props.hasClient ? "No threads yet" : "No connection yet"}
                detail={
                  props.hasClient
                    ? "Create a thread below or resume one in another T3 client, then refresh this screen."
                    : "Connect this mobile app to your T3 server to load active threads."
                }
              />
            ) : null}

            {groupedProjects.map(({ project, threads }) => {
              const sortedThreads = orderThreadsByRecency(threads);
              const latestThread = sortedThreads[0];
              const remainingThreads = sortedThreads.slice(1);
              const isExpanded = expandedProjectIds.has(project.id);

              return (
                <SectionPanel key={project.id} palette={palette}>
                  <View className="gap-4">
                    <View
                      className="gap-2 px-4 py-4"
                      style={{ borderBottomWidth: 1, borderBottomColor: palette.border }}
                    >
                      <View className="flex-row items-start justify-between gap-3">
                        <View className="flex-1 gap-1.5">
                          <Glyph name="folder" color={palette.muted} size={15} />
                          <Text
                            className="text-[22px] font-extrabold leading-[26px]"
                            style={{ color: palette.text }}
                          >
                            {project.title}
                          </Text>
                        </View>

                        <View
                          className="flex-row items-center gap-2 px-3 py-2"
                          style={{ backgroundColor: palette.tabActive }}
                        >
                          <Glyph name="stack" color={palette.tabActiveText} size={14} />
                          <Text
                            className="text-[11px] font-bold uppercase"
                            style={{ color: palette.tabActiveText, letterSpacing: 1.1 }}
                          >
                            {threads.length}
                          </Text>
                        </View>
                      </View>

                      <Text className="text-[13px] leading-[18px]" style={{ color: palette.muted }}>
                        {project.workspaceRoot}
                      </Text>

                      <ProjectActionButton
                        palette={palette}
                        label="New thread"
                        icon="spark"
                        onPress={() => void props.onCreateThread(project.id)}
                      />
                    </View>

                    <Animated.View className="px-4 py-1" layout={LinearTransition.duration(220)}>
                      {latestThread ? (
                        <ThreadRow
                          key={latestThread.id}
                          thread={latestThread}
                          hidden={props.hiddenThreadId === latestThread.id}
                          isLast={!isExpanded || remainingThreads.length === 0}
                          onPress={(sourceFrame) =>
                            props.onSelectThread(latestThread.id, sourceFrame)
                          }
                          palette={palette}
                        />
                      ) : (
                        <View className="px-1 py-6">
                          <EmptyState
                            title="No threads in this project"
                            detail="Start a new thread here to begin working from mobile."
                          />
                        </View>
                      )}

                      {isExpanded && remainingThreads.length > 0 ? (
                        <Animated.View
                          entering={FadeInDown.duration(220)}
                          exiting={FadeOutUp.duration(180)}
                          layout={LinearTransition.duration(220)}
                        >
                          {remainingThreads.map((thread, index) => (
                            <ThreadRow
                              key={thread.id}
                              thread={thread}
                              hidden={props.hiddenThreadId === thread.id}
                              isLast={index === remainingThreads.length - 1}
                              onPress={(sourceFrame) =>
                                props.onSelectThread(thread.id, sourceFrame)
                              }
                              palette={palette}
                            />
                          ))}
                        </Animated.View>
                      ) : null}

                      {remainingThreads.length > 0 ? (
                        <ExpandThreadsToggle
                          expanded={isExpanded}
                          hiddenCount={remainingThreads.length}
                          palette={palette}
                          onPress={() => {
                            setExpandedProjectIds((current) => {
                              const next = new Set(current);
                              if (next.has(project.id)) {
                                next.delete(project.id);
                              } else {
                                next.add(project.id);
                              }
                              return next;
                            });
                          }}
                        />
                      ) : null}
                    </Animated.View>
                  </View>
                </SectionPanel>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
