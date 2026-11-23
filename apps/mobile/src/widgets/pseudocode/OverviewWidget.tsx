import { Divider, HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  background,
  clipShape,
  contentShape,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  monospacedDigit,
  padding,
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
    you: "You",
    agent: "Agent",
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
  const waitingRows = active.filter((row) => row.phase.startsWith("waiting"));
  const workingRows = active.filter((row) => !row.phase.startsWith("waiting"));
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

  const heading = (title: string, section = false) => (
    <Text
      modifiers={[
        font({ textStyle: section ? "subheadline" : "headline", weight: "semibold" }),
        ...(section ? [foregroundStyle("secondary")] : []),
        lineLimit(small ? 2 : 1),
      ]}
    >
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
      spacing={3}
      modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
    >
      <Text
        modifiers={[
          font({ size: small ? 25 : 22, weight: "semibold" }),
          monospacedDigit(),
          foregroundStyle(tint),
          lineLimit(1),
        ]}
      >
        {String(value)}
      </Text>
      <Text
        modifiers={[
          font({ textStyle: "caption", weight: "medium" }),
          foregroundStyle("secondary"),
          lineLimit(2),
          fixedSize({ vertical: true }),
        ]}
      >
        {label}
      </Text>
    </VStack>
  );

  const row = (item: OverviewRow, showDetail: boolean, previewLines = 0) => {
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
    const message = previewLines > 0 ? props.work?.messages?.[item.deepLink] : undefined;
    const messageAuthor = message?.role === "user" ? (copy.you ?? "You") : (copy.agent ?? "Agent");
    const content = (
      <HStack
        spacing={10}
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
              clipShape("roundedRectangle", 6),
              accessibilityHidden(),
            ]}
          />
        ) : (
          <Image
            systemName="folder"
            modifiers={[
              font({ size: 16 }),
              foregroundStyle("secondary"),
              frame({ width: 24, height: 24 }),
              accessibilityHidden(),
            ]}
          />
        )}
        <VStack
          alignment="leading"
          spacing={3}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ textStyle: "subheadline", weight: "semibold" }),
              lineLimit(large && (wide ? previewLines > 2 : view !== "review") ? 2 : 1),
              fixedSize({ vertical: true }),
              privacySensitive(),
            ]}
          >
            {item.threadTitle}
          </Text>
          <HStack spacing={5}>
            <Text
              modifiers={[
                font({ textStyle: "caption", weight: "medium" }),
                foregroundStyle(color(phase)),
                lineLimit(1),
                layoutPriority(1),
              ]}
            >
              {labels[phase]}
            </Text>
            {caption("·")}
            {caption(
              showDetail && item.summary && phase !== "stale" ? item.summary : item.projectTitle,
              "secondary",
              true,
            )}
            {view === "recent" && (wide || !message) ? (
              <>
                <Spacer minLength={0} />
                <Text
                  date={new Date(item.updatedAt)}
                  dateStyle="relative"
                  modifiers={[
                    font({ textStyle: "caption" }),
                    foregroundStyle("secondary"),
                    lineLimit(1),
                  ]}
                />
              </>
            ) : null}
          </HStack>
          {message ? (
            <Text
              modifiers={[
                font({ textStyle: wide ? "footnote" : "caption" }),
                foregroundStyle("secondary"),
                lineLimit(previewLines),
                privacySensitive(),
              ]}
            >
              {`${messageAuthor} · ${message.text}`}
            </Text>
          ) : null}
        </VStack>
        <Image
          systemName="chevron.right"
          modifiers={[
            font({ size: 10, weight: "semibold" }),
            foregroundStyle("secondary"),
            accessibilityHidden(),
          ]}
        />
      </HStack>
    );
    return (
      <Link key={`${item.environmentId}:${item.threadId}`} destination={url(item.deepLink)}>
        {content}
      </Link>
    );
  };

  const list = (
    items: readonly OverviewRow[],
    empty: string,
    detail = false,
    firstPreview = 0,
    otherPreviews = 0,
  ) =>
    items.length ? (
      <VStack alignment="leading" spacing={8}>
        {items.map((item, index) => row(item, detail, index === 0 ? firstPreview : otherPreviews))}
      </VStack>
    ) : (
      caption(empty)
    );

  const panelStyle = tinted
    ? []
    : [background(dark ? "#23252B" : "#EBEEF3", shapes.roundedRectangle({ cornerRadius: 12 }))];
  const statsStyle = small || tinted ? [] : [padding({ all: 8 }), ...panelStyle];
  const breakdown = [
    { count: approvals, label: copy.approvals },
    { count: questions, label: copy.questions },
    { count: props.activeProjectCount, label: copy.projects },
  ].filter(({ count }) => count !== undefined && (count > 0 || view === "active"));
  const stats = (
    <VStack alignment="leading" spacing={6}>
      <HStack spacing={small ? 8 : 4} alignment="top" modifiers={statsStyle}>
        {metric(working, copy.working, working > 0 ? color(stalePhase("running")) : "primary")}
        {metric(
          waiting,
          copy.waiting,
          waiting > 0 ? color(stalePhase("waiting_for_approval")) : "primary",
        )}
        {large && ready !== undefined ? metric(ready, copy.review) : null}
      </HStack>
      {large && breakdown.length > 0 ? (
        <Text
          modifiers={[font({ textStyle: "caption" }), foregroundStyle("secondary"), lineLimit(2)]}
        >
          {breakdown.map(({ count, label }) => `${label} ${count}`).join(" · ")}
        </Text>
      ) : null}
      {delayed ? caption(copy.lastKnown) : null}
    </VStack>
  );

  const recentEmpty = props.work ? copy.noRecent : copy.sync;
  const reviewEmpty = props.work ? copy.noReview : copy.sync;
  const smallRequest =
    small && !delayed && (view === "overview" || view === "active") ? waitingRows[0] : undefined;
  const smallThread = small
    ? view === "recent"
      ? recent[0]
      : view === "review"
        ? review[0]
        : smallRequest
    : undefined;
  const root = [
    frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
    widgetURL(url(smallThread?.deepLink)),
  ];
  const column = [frame({ maxWidth: Infinity, alignment: "topLeading" })];
  const focusCard = (item: OverviewRow, label?: string, previewLines = 4) => (
    <VStack alignment="leading" spacing={5} modifiers={[padding({ all: 12 }), ...panelStyle]}>
      {label ? heading(label, true) : null}
      {row(item, true, previewLines)}
    </VStack>
  );

  if (wide && (view === "overview" || view === "active")) {
    const activeOnly = view === "active";
    const focus =
      waitingRows[0] ?? workingRows[0] ?? (activeOnly ? undefined : (review[0] ?? recent[0]));
    const focusLabel =
      waitingRows.length > 0
        ? copy.waiting
        : active.length > 0
          ? copy.working
          : review.length > 0
            ? copy.review
            : copy.recent;
    const nextReview = review.find((item) => item.deepLink !== focus?.deepLink);
    const otherRecent = recent.filter((item) => item.deepLink !== focus?.deepLink);
    const remainingWaiting = waitingRows.filter((item) => item.deepLink !== focus?.deepLink);
    const remainingWorking = workingRows.filter((item) => item.deepLink !== focus?.deepLink);
    const showRecent = otherRecent.length > 0 || recent.length === 0;
    const showRight = activeOnly
      ? remainingWaiting.length > 0 || remainingWorking.length > 0
      : showRecent || nextReview !== undefined;
    return (
      <HStack alignment="top" spacing={16} modifiers={root}>
        <VStack alignment="leading" spacing={10} modifiers={column}>
          {heading(copy.active)}
          {props.activities === undefined ? caption(copy.sync) : stats}
          {focus
            ? focusCard(focus, focusLabel)
            : props.activities !== undefined
              ? caption(copy.noActive)
              : null}
          {!activeOnly && focus && !props.work?.messages?.[focus.deepLink] && remainingWorking[0]
            ? row(remainingWorking[0], true)
            : null}
        </VStack>
        {showRight ? <Divider /> : null}
        {showRight ? (
          <VStack alignment="leading" spacing={8} modifiers={column}>
            {activeOnly ? (
              <>
                {remainingWaiting.length ? heading(copy.waiting) : null}
                {remainingWaiting
                  .slice(0, 2)
                  .map((item, index) => row(item, true, index === 0 ? 1 : 0))}
                {remainingWorking.length ? heading(copy.working) : null}
                {remainingWorking
                  .slice(0, remainingWaiting.length >= 2 ? 1 : 2)
                  .map((item, index) => row(item, true, index === 0 ? 1 : 0))}
              </>
            ) : (
              <>
                {showRecent ? heading(copy.recent) : null}
                {showRecent ? list(otherRecent, recentEmpty, false, 1) : null}
                {nextReview ? (
                  <>
                    {showRecent ? <Divider /> : null}
                    {heading(copy.review)}
                    {row(nextReview, false)}
                  </>
                ) : null}
              </>
            )}
          </VStack>
        ) : null}
      </HStack>
    );
  }

  const resultCounts = props.work ? (
    <HStack spacing={8} alignment="top" modifiers={statsStyle}>
      {metric(props.work.finished, copy.finished, color("completed"))}
      {metric(props.work.failed, copy.failed, color("failed"))}
    </HStack>
  ) : null;

  const detailRows = view === "recent" ? recent : review;
  const detailTitle = view === "recent" ? copy.recent : copy.review;
  const detailEmpty = view === "recent" ? recentEmpty : reviewEmpty;
  if (wide && (view === "recent" || view === "review") && detailRows[0]) {
    const otherPreviewLines = view === "recent" ? 4 : 1;
    return (
      <VStack alignment="leading" spacing={10} modifiers={root}>
        {heading(detailTitle)}
        <HStack alignment="top" spacing={16}>
          <VStack alignment="leading" spacing={8} modifiers={column}>
            {view === "review" ? resultCounts : null}
            {focusCard(detailRows[0], undefined, 6)}
          </VStack>
          {detailRows.length > 1 ? (
            <>
              <Divider />
              <VStack alignment="leading" spacing={8} modifiers={column}>
                {list(
                  detailRows.slice(1, view === "recent" ? 3 : 5),
                  detailEmpty,
                  false,
                  otherPreviewLines,
                  otherPreviewLines,
                )}
              </VStack>
            </>
          ) : null}
        </HStack>
      </VStack>
    );
  }

  if (view === "recent" || view === "review") {
    const isRecent = view === "recent";
    const limit = small ? 1 : large ? (isRecent ? 3 : 4) : 2;
    return (
      <VStack alignment="leading" spacing={8} modifiers={root}>
        {heading(detailTitle)}
        {large && !isRecent ? resultCounts : null}
        {list(
          detailRows.slice(0, limit),
          detailEmpty,
          false,
          large ? (isRecent ? 2 : 1) : 0,
          wide ? 1 : 0,
        )}
        {!small ? <Spacer minLength={0} /> : null}
      </VStack>
    );
  }

  const showActive = view === "active" || active.length > 0;
  const rows = showActive ? active : recent;
  return (
    <VStack alignment="leading" spacing={large ? 9 : 6} modifiers={root}>
      {heading(small || view === "active" ? copy.active : copy.overview)}
      {props.activities === undefined ? caption(copy.sync) : stats}
      {smallRequest ? (
        <VStack alignment="leading" spacing={2}>
          {caption(labels[smallRequest.phase], color(smallRequest.phase))}
          {caption(smallRequest.threadTitle, "secondary", true)}
        </VStack>
      ) : null}
      {!small && props.activities !== undefined ? (
        <>
          {large && view === "overview" && rows.length > 0
            ? heading(showActive ? copy.active : copy.recent, true)
            : null}
          {list(
            rows.slice(0, large ? 3 : 1),
            showActive ? copy.noActive : recentEmpty,
            large,
            large && rows.length <= 1 ? 2 : 0,
          )}
        </>
      ) : null}
      <Spacer minLength={0} />
    </VStack>
  );
}

export default createWidget<AgentWidgetSnapshot, OverviewConfiguration>(
  "PseudoCodeOverview",
  OverviewWidget,
);
