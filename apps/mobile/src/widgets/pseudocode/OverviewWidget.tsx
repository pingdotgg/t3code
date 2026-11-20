import { Divider, HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  contentShape,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  monospacedDigit,
  privacySensitive,
  resizable,
  shapes,
  widgetAccentedRenderingMode,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { AgentWidgetSnapshot } from "../agentWidgetSnapshot";
import type { WorkThread } from "./workSnapshot";

type OverviewConfiguration = { readonly view?: "overview" | "active" | "recent" | "review" };
type OverviewRow = WorkThread & { readonly projectIcon?: string; readonly summary?: string };

export function OverviewWidget(
  props: Partial<AgentWidgetSnapshot> = {},
  environment: WidgetEnvironment<OverviewConfiguration>,
) {
  "widget";

  const copy = props.overviewText ?? {
    overview: "Overview",
    active: "Active now",
    recent: "Recent threads",
    review: "Ready to review",
    working: "Working",
    waiting: "Need you",
    approvals: "Approvals",
    questions: "Questions",
    projects: "Projects",
    starting: "Starting",
    approval: "Approval needed",
    input: "Needs your input",
    finished: "Completed",
    failed: "Failed",
    idle: "Idle",
    lastKnown: "Last known",
    noActive: "No active threads",
    noRecent: "No recent threads",
    noReview: "All caught up",
    sync: "Open PseudoCode to refresh",
  };
  const family = environment.widgetFamily;
  const small = family === "systemSmall";
  const wide = family === "systemExtraLarge";
  const large = wide || family === "systemLarge";
  const view = environment.configuration?.view ?? (small ? "active" : "overview");
  const dark = environment.colorScheme !== "light";
  const tinted =
    environment.widgetRenderingMode === "accented" ||
    environment.widgetRenderingMode === "vibrant" ||
    environment.isLuminanceReduced;
  const now = Math.max(environment.date?.getTime() ?? 0, Date.now());
  const delayed = props.overviewStaleAt !== undefined && now >= props.overviewStaleAt;
  const scheme = props.appScheme ?? "t3code";
  const url = (path?: string) =>
    path?.startsWith("/threads/") && !path.includes("?") && !path.includes("#")
      ? `${scheme}://${path.slice(1)}`
      : `${scheme}://`;
  const working = Math.max(0, (props.activeCount ?? 0) - (props.attentionCount ?? 0));
  const waiting = props.attentionCount ?? 0;
  const approvals = props.approvalCount;
  const questions = approvals === undefined ? undefined : Math.max(0, waiting - approvals);
  const ready = props.work ? props.work.finished + props.work.failed : undefined;
  const inFlight = (phase: WorkThread["phase"]) =>
    phase === "starting" || phase === "running" || phase.startsWith("waiting");
  const active = (props.activities ?? []).filter((row) => inFlight(row.phase));
  const recent = (props.work?.recent ?? []).map((row) => {
    const source =
      props.environments?.find((entry) => entry.environmentId === row.environmentId)?.snapshot ??
      props;
    const current = source.activities?.find(
      (activity) =>
        activity.environmentId === row.environmentId && activity.threadId === row.threadId,
    );
    if (current && current.updatedAt >= row.updatedAt) return { ...row, phase: current.phase };
    return !current && inFlight(row.phase) ? { ...row, phase: "stale" as const } : row;
  });
  const review = props.work?.review ?? [];
  const stalePhase = (phase: WorkThread["phase"]) => (delayed && inFlight(phase) ? "stale" : phase);
  const labels = {
    starting: copy.starting,
    running: copy.working,
    waiting_for_approval: copy.approval,
    waiting_for_input: copy.input,
    completed: copy.finished,
    failed: copy.failed,
    idle: copy.idle,
    stale: copy.lastKnown,
  };
  const color = (phase: WorkThread["phase"]) => {
    if (tinted || phase === "idle" || phase === "stale") return "secondary";
    if (phase === "waiting_for_approval") return dark ? "#ffd08a" : "#854b0b";
    if (phase === "waiting_for_input") return dark ? "#d4bbff" : "#60399b";
    if (phase === "completed") return dark ? "#82e4c0" : "#086445";
    if (phase === "failed") return dark ? "#ffa1ae" : "#a82442";
    return dark ? "#91ccff" : "#235e9a";
  };

  const heading = (title: string) => (
    <Text modifiers={[font({ textStyle: "headline", weight: "semibold" }), lineLimit(1)]}>
      {title}
    </Text>
  );
  const caption = (label: string, tint = "secondary", sensitive = false) => (
    <Text
      modifiers={[
        font({ textStyle: "caption" }),
        foregroundStyle(tint),
        lineLimit(1),
        ...(sensitive ? [privacySensitive()] : []),
      ]}
    >
      {label}
    </Text>
  );
  const metric = (value: number, label: string, tint = "primary") => (
    <VStack
      alignment="leading"
      spacing={1}
      modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
    >
      <Text
        modifiers={[
          font({ size: small ? 28 : 24, weight: "bold" }),
          monospacedDigit(),
          foregroundStyle(tint),
          lineLimit(1),
        ]}
      >
        {String(value)}
      </Text>
      {caption(label)}
    </VStack>
  );

  const row = (item: OverviewRow, showDetail: boolean) => {
    const phase = stalePhase(item.phase);
    if (small) {
      return (
        <VStack alignment="leading" spacing={4}>
          <Text
            modifiers={[
              font({ textStyle: "subheadline", weight: "semibold" }),
              lineLimit(2),
              privacySensitive(),
            ]}
          >
            {item.threadTitle}
          </Text>
          {caption(item.projectTitle, "secondary", true)}
          {caption(labels[phase], color(phase))}
        </VStack>
      );
    }
    const icon =
      item.projectIcon ?? props.projectIcons?.[`${item.environmentId}:${item.projectId}`];
    const content = (
      <HStack
        spacing={8}
        modifiers={[
          frame({ maxWidth: Infinity, minHeight: 44, alignment: "leading" }),
          contentShape(shapes.rectangle()),
        ]}
      >
        {icon ? (
          <Image
            uiImage={icon}
            modifiers={[
              resizable(),
              widgetAccentedRenderingMode("fullColor"),
              frame({ width: 24, height: 24 }),
            ]}
          />
        ) : (
          <Image
            systemName="folder"
            modifiers={[font({ size: 18 }), foregroundStyle("secondary")]}
          />
        )}
        <VStack
          alignment="leading"
          spacing={2}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ textStyle: "subheadline", weight: "semibold" }),
              lineLimit(1),
              privacySensitive(),
            ]}
          >
            {item.threadTitle}
          </Text>
          {caption(
            showDetail && item.summary && phase !== "stale" ? item.summary : item.projectTitle,
            "secondary",
            true,
          )}
        </VStack>
        <VStack
          alignment="trailing"
          spacing={2}
          modifiers={[
            frame({ maxWidth: wide ? 142 : 105, alignment: "trailing" }),
            layoutPriority(1),
          ]}
        >
          {caption(labels[phase], color(phase))}
          <Text
            date={new Date(item.updatedAt)}
            dateStyle="relative"
            modifiers={[
              font({ textStyle: "caption2" }),
              foregroundStyle("secondary"),
              lineLimit(1),
            ]}
          />
        </VStack>
      </HStack>
    );
    return (
      <Link key={`${item.environmentId}:${item.threadId}`} destination={url(item.deepLink)}>
        {content}
      </Link>
    );
  };

  const list = (items: readonly OverviewRow[], empty: string, detail = false) =>
    items.length ? (
      <VStack alignment="leading" spacing={8}>
        {items.map((item) => row(item, detail))}
      </VStack>
    ) : (
      caption(empty)
    );

  const stats = (withBreakdown: boolean) => (
    <VStack alignment="leading" spacing={wide ? 10 : 6}>
      <HStack spacing={small ? 8 : 12} alignment="top">
        {metric(working, copy.working, color(stalePhase("running")))}
        {metric(waiting, copy.waiting, color(stalePhase("waiting_for_approval")))}
        {large && ready !== undefined ? metric(ready, copy.review) : null}
      </HStack>
      {withBreakdown && (approvals !== undefined || props.activeProjectCount !== undefined) ? (
        <HStack spacing={10} alignment="top">
          {approvals !== undefined ? metric(approvals, copy.approvals) : null}
          {questions !== undefined ? metric(questions, copy.questions) : null}
          {props.activeProjectCount !== undefined
            ? metric(props.activeProjectCount, copy.projects)
            : null}
        </HStack>
      ) : null}
      {delayed ? caption(copy.lastKnown) : null}
    </VStack>
  );

  const recentEmpty = props.work ? copy.noRecent : copy.sync;
  const reviewEmpty = props.work ? copy.noReview : copy.sync;
  const smallThread = small
    ? view === "recent"
      ? recent[0]
      : view === "review"
        ? review[0]
        : undefined
    : undefined;
  const root = [
    frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
    widgetURL(url(smallThread?.deepLink)),
  ];

  if (wide && view === "overview") {
    return (
      <HStack alignment="top" spacing={20} modifiers={root}>
        <VStack
          alignment="leading"
          spacing={10}
          modifiers={[frame({ maxWidth: Infinity, alignment: "topLeading" })]}
        >
          {heading(copy.active)}
          {props.activities === undefined ? caption(copy.sync) : stats(true)}
          <Divider />
          {list(active.slice(0, 2), copy.noActive, true)}
        </VStack>
        <Divider />
        <VStack
          alignment="leading"
          spacing={8}
          modifiers={[frame({ maxWidth: Infinity, alignment: "topLeading" })]}
        >
          {heading(copy.recent)}
          {list(recent, recentEmpty)}
          <Divider />
          {heading(copy.review)}
          {list(review.slice(0, 1), reviewEmpty)}
        </VStack>
      </HStack>
    );
  }

  if (view === "recent" || view === "review") {
    const isRecent = view === "recent";
    const limit = small ? 1 : large ? (isRecent ? 3 : wide ? 5 : 4) : 2;
    return (
      <VStack alignment="leading" spacing={8} modifiers={root}>
        {heading(isRecent ? copy.recent : copy.review)}
        {large && !isRecent && props.work ? (
          <HStack spacing={12}>
            {metric(props.work.finished, copy.finished, color("completed"))}
            {metric(props.work.failed, copy.failed, color("failed"))}
          </HStack>
        ) : null}
        {list((isRecent ? recent : review).slice(0, limit), isRecent ? recentEmpty : reviewEmpty)}
        {!small ? <Spacer minLength={0} /> : null}
      </VStack>
    );
  }

  const rows = view === "active" ? active : (props.activities ?? []);
  return (
    <VStack alignment="leading" spacing={large ? 9 : 6} modifiers={root}>
      {heading(small || view === "active" ? copy.active : copy.overview)}
      {props.activities === undefined ? caption(copy.sync) : stats(large)}
      {!small && props.activities !== undefined
        ? list(rows.slice(0, large ? 3 : 1), copy.noActive, large)
        : null}
      <Spacer minLength={0} />
    </VStack>
  );
}

export default createWidget<AgentWidgetSnapshot, OverviewConfiguration>(
  "PseudoCodeOverview",
  OverviewWidget,
);
