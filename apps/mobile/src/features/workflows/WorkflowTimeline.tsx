import {
  workflowAgentSummary,
  isOwnWorkflowAnswer,
  workflowAnswer,
  workflowWithdrawal,
  workflowOneLine,
  workflowResultLines,
  workflowRunNow,
  workflowStepTime,
  type WorkflowBeat,
  type WorkflowFeedRow,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowQuestion } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

type StepTone = "working" | "input" | "quiet" | "done" | "failed" | "ended";

// The rail's centre is 10pt in; a row is 36pt tall with its mark centred 18pt down. A fork's steps
// are 32pt rows whose dots sit 39pt in and 16pt down, so the branch can be drawn without measuring.
const ROW = 36;
const SUB_ROW = 32;

interface Palette {
  readonly working: string;
  readonly input: string;
  readonly muted: string;
  readonly failed: string;
  readonly rail: string;
  readonly screen: string;
}

const colorOf = (
  style: ReturnType<typeof useResolveClassNames>,
  key: "color" | "backgroundColor",
) => String((StyleSheet.flatten(style) as Record<string, unknown>)[key] ?? "transparent");

/** The theme's colours for what is drawn rather than styled: marks and the branch. */
function usePalette(): Palette {
  return {
    working: colorOf(useResolveClassNames("text-primary"), "color"),
    input: colorOf(useResolveClassNames("text-warning-foreground"), "color"),
    muted: colorOf(useResolveClassNames("text-foreground-muted"), "color"),
    failed: colorOf(useResolveClassNames("text-danger-foreground"), "color"),
    rail: colorOf(useResolveClassNames("bg-border"), "backgroundColor"),
    screen: colorOf(useResolveClassNames("bg-screen"), "backgroundColor"),
  };
}

/** A step's place on the rail: a ring, filled while it works, ticked when it is done. */
function StepMark(props: { readonly tone: StepTone; readonly palette: Palette }) {
  const { tone, palette } = props;
  const ring =
    tone === "working"
      ? palette.working
      : tone === "input"
        ? palette.input
        : tone === "failed"
          ? palette.failed
          : palette.muted;
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20">
      {/* Keyed by state: react-native-svg keeps a dash pattern once the prop is removed. */}
      <Circle
        key={tone}
        cx={10}
        cy={10}
        r={8.2}
        fill={palette.screen}
        stroke={ring}
        strokeOpacity={tone === "done" || tone === "quiet" || tone === "ended" ? 0.5 : 1}
        strokeWidth={1.6}
        strokeDasharray={tone === "input" ? "2.6 2.2" : undefined}
      />
      {tone === "working" || tone === "input" || tone === "quiet" ? (
        <Circle cx={10} cy={10} r={3.4} fill={ring} fillOpacity={tone === "quiet" ? 0.6 : 1} />
      ) : tone === "done" ? (
        <Path
          d="M6.3 10.3l2.5 2.4 4.9-5"
          fill="none"
          stroke={palette.muted}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : tone === "failed" ? (
        <Path
          d="M10 6.2v4.6M10 13.6v.1"
          fill="none"
          stroke={palette.failed}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      ) : (
        <Path d="M6.6 10h6.8" fill="none" stroke={palette.muted} strokeWidth={1.6} />
      )}
    </Svg>
  );
}

/** A fork's step: a small dot on the branch, filled while it works or once it is done. */
function StepDot(props: { readonly tone: StepTone; readonly palette: Palette }) {
  const { tone, palette } = props;
  const color =
    tone === "working"
      ? palette.working
      : tone === "input"
        ? palette.input
        : tone === "failed"
          ? palette.failed
          : palette.muted;
  const filled = tone !== "quiet";
  return (
    <Svg width={10} height={10} viewBox="0 0 10 10">
      <Circle
        cx={5}
        cy={5}
        r={4}
        fill={filled ? color : palette.screen}
        fillOpacity={tone === "done" ? 0.45 : 1}
        stroke={color}
        strokeOpacity={tone === "done" ? 0 : 1}
        strokeWidth={2}
      />
    </Svg>
  );
}

const VERB_TONE = {
  working: "text-primary",
  input: "text-warning-foreground",
  quiet: "text-foreground-muted",
} as const;

/** One line of the run: its mark, its name and what came of it, what it is doing, its time. */
function TimelineRow(props: {
  readonly tone: StepTone;
  readonly palette: Palette;
  readonly name: string;
  readonly aside: string | null;
  readonly asideFailed?: boolean;
  readonly verb: string | null;
  readonly verbTone?: keyof typeof VERB_TONE;
  readonly time: string | null;
  readonly sub?: boolean;
  readonly onPress?: () => void;
}) {
  const live = props.tone === "working" || props.tone === "input";
  const label = [props.name, props.verb ?? props.aside ?? "", props.time ?? ""]
    .filter((part) => part !== "")
    .join(", ");
  const body = (
    <>
      {props.sub === true ? (
        <View style={styles.dotSlot}>
          <StepDot tone={props.tone} palette={props.palette} />
        </View>
      ) : (
        <StepMark tone={props.tone} palette={props.palette} />
      )}
      {/* The name keeps its room; what came of it gives way first. */}
      <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
        <Text
          numberOfLines={1}
          className={cn(
            "max-w-[60%] text-sm",
            live ? "font-t3-medium text-foreground" : "text-foreground-secondary",
          )}
        >
          {props.name}
        </Text>
        {props.aside === null ? null : (
          <Text
            numberOfLines={1}
            className={cn(
              "min-w-0 flex-1 text-xs",
              props.asideFailed === true ? "text-danger-foreground" : "text-foreground-muted",
            )}
          >
            {props.aside}
          </Text>
        )}
      </View>
      {props.verb === null ? null : (
        <Text className={cn("text-xs", VERB_TONE[props.verbTone ?? "working"])}>{props.verb}</Text>
      )}
      <Text className="min-w-10 text-right text-xs text-foreground-muted tabular-nums">
        {props.time ?? ""}
      </Text>
    </>
  );
  const height = props.sub === true ? SUB_ROW : ROW;
  return props.onPress === undefined ? (
    <View className="flex-row items-center gap-2.5" style={{ height }}>
      {body}
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={props.onPress}
      className="flex-row items-center gap-2.5 active:opacity-60"
      style={{ height }}
    >
      {body}
    </Pressable>
  );
}

/** The rail beside a row: from the row above to its mark, and on unless the row is last. */
function Rail(props: { readonly first: boolean; readonly last: boolean }) {
  if (props.first && props.last) return null;
  return (
    <View
      pointerEvents="none"
      className="absolute w-0.5 bg-border"
      style={{
        left: 9,
        top: props.first ? ROW / 2 : 0,
        ...(props.last ? { height: props.first ? 0 : ROW / 2 } : { bottom: 0 }),
      }}
    />
  );
}

/** Where a fork leaves the rail under its mark, and where it rejoins below its last step. */
function BranchOut(props: { readonly palette: Palette }) {
  return (
    <Svg
      pointerEvents="none"
      width={32}
      height={24}
      viewBox="0 0 32 24"
      style={[styles.absolute, { left: 9, top: ROW / 2 + 10 }]}
    >
      <Path
        d="M1 0V3Q1 10 8 10H23Q30 10 30 17V24"
        fill="none"
        stroke={props.palette.rail}
        strokeWidth={2}
      />
    </Svg>
  );
}

function BranchBack(props: { readonly palette: Palette }) {
  return (
    <>
      <Svg
        pointerEvents="none"
        width={32}
        height={16}
        viewBox="0 0 32 16"
        style={[styles.absolute, { left: 9, top: SUB_ROW / 2 }]}
      >
        <Path
          d="M30 0Q30 8 23 8H8Q1 8 1 15V16"
          fill="none"
          stroke={props.palette.rail}
          strokeWidth={2}
        />
      </Svg>
      <View
        pointerEvents="none"
        className="absolute w-0.5 bg-border"
        style={{ left: 9, top: SUB_ROW, bottom: 0 }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  absolute: { position: "absolute" },
  // The dot's slot puts its centre on the branch, 39pt in.
  dotSlot: { width: 20, marginLeft: 29, alignItems: "center", justifyContent: "center" },
});

/**
 * The run as it went, one line per step that took time or involved someone, read top to bottom.
 * A tap opens the step. A question is answered right under the step that asks it.
 */
export function WorkflowTimeline(props: {
  readonly rows: ReadonlyArray<WorkflowFeedRow>;
  readonly node: WorkflowRunNode;
  /** This device's session on the run's environment: an answer it gave reads as yours. */
  readonly sessionId: string | null;
  /** The question a step waits on a person for. */
  readonly question: (beat: WorkflowBeat) => WorkflowQuestion | null;
  readonly loose: ReadonlyArray<WorkflowQuestion>;
  readonly renderQuestion: (question: WorkflowQuestion) => ReactNode;
  readonly pausedAt: WorkflowBeat | null;
  readonly pause: ReactNode;
  readonly onOpenStep: (step: string) => void;
  /** When the run was opened here: steps that start after it arrive with a short fade. */
  readonly openedAtMs: number;
}) {
  const { node } = props;
  const { run } = node;
  const gt = useGT();
  const m = useMessages();
  const palette = usePalette();
  const asks = (beat: WorkflowBeat) =>
    beat.status === "running" && (beat.kind === "ask" || props.question(beat) !== null);

  const toneOf = (beat: WorkflowBeat): StepTone =>
    beat.status === "failed"
      ? "failed"
      : asks(beat)
        ? "input"
        : beat.status === "running"
          ? beat.kind === "sleep" || beat.kind === "wait" || beat.kind === "queue"
            ? "quiet"
            : "working"
          : "done";
  const verbOf = (beat: WorkflowBeat): string | null => {
    if (beat.status !== "running") return null;
    if (asks(beat))
      return props.question(beat) === null
        ? null
        : gt("Needs you", { $context: "workflow run status: it waits on a person" });
    switch (beat.kind) {
      case "agent":
        return gt("working");
      case "sleep":
        return gt("sleeping");
      case "wait":
        return gt("waiting");
      case "queue":
        return beat.ahead === undefined || beat.ahead === 0
          ? gt("queued, next in line", { $context: "a workflow step waits for a free place" })
          : gt("{count, plural, one {queued, {count} ahead} other {queued, {count} ahead}}", {
              count: beat.ahead,
            });
      default:
        return gt("under way");
    }
  };
  const asideOf = (beat: WorkflowBeat): string | null => {
    if (beat.status === "failed") return workflowOneLine(beat.detail ?? gt("failed"));
    if (beat.status === "running") return null;
    switch (beat.kind) {
      case "agent": {
        const said = workflowAgentSummary(beat).said;
        return said === null ? null : workflowOneLine(said);
      }
      case "ask": {
        const answer = workflowAnswer(beat.result);
        if (answer !== null)
          return isOwnWorkflowAnswer(answer, props.sessionId)
            ? gt("You answered {choice}", { choice: answer.choice })
            : answer.answeredBy === null
              ? gt("Answered {choice}", { choice: answer.choice })
              : gt("{who} answered {choice}", { who: answer.answeredBy, choice: answer.choice });
        const withdrawal = workflowWithdrawal(beat.result);
        return withdrawal === null
          ? gt("nobody answered")
          : gt("withdrawn by {by}", { by: withdrawal.by });
      }
      case "run": {
        const child = node.children.find(
          (candidate) => candidate.run.runId === beat.childRun?.runId,
        );
        return child === undefined ? null : workflowRunNow(child, m);
      }
      case "step": {
        const first = workflowResultLines(beat.result)[0];
        return first === undefined
          ? null
          : first.label === null
            ? first.value
            : `${first.label}: ${first.value}`;
      }
      default:
        return null;
    }
  };
  // The page has no ticking clock, so a step under way shows no time.
  const timeOf = (beat: WorkflowBeat) =>
    beat.status === "running" ? null : workflowStepTime(beat.endMs - beat.startMs);
  const enters = (startMs: number) =>
    startMs > props.openedAtMs ? FadeIn.duration(180) : undefined;

  const beatRow = (beat: WorkflowBeat, sub = false) => (
    <TimelineRow
      tone={toneOf(beat)}
      palette={palette}
      name={beat.childRun?.title ?? beat.name}
      aside={asideOf(beat)}
      asideFailed={beat.status === "failed"}
      verb={verbOf(beat)}
      verbTone={
        asks(beat)
          ? "input"
          : beat.kind === "sleep" || beat.kind === "wait" || beat.kind === "queue"
            ? "quiet"
            : "working"
      }
      time={timeOf(beat)}
      sub={sub}
      onPress={() => props.onOpenStep(beat.name)}
    />
  );
  const under = (beat: WorkflowBeat) => {
    const asked = props.question(beat);
    return (
      <>
        {asked === null ? null : (
          <View className="mt-1 mb-2 ms-8">{props.renderQuestion(asked)}</View>
        )}
        {beat === props.pausedAt ? <View className="mt-1 mb-2 ms-8">{props.pause}</View> : null}
      </>
    );
  };

  const items: Array<{
    readonly key: string;
    readonly startMs: number;
    readonly branch?: boolean;
    readonly body: ReactNode;
  }> = [];
  for (const row of props.rows) {
    if (row.kind === "quick") {
      const names = row.steps.map((step) => step.name);
      items.push({
        key: names[0] ?? "quick",
        startMs: row.startMs,
        body: (
          <TimelineRow
            tone="done"
            palette={palette}
            name={
              names.length <= 2
                ? names.join(" · ")
                : gt("{names} and {count} more", {
                    names: names.slice(0, 2).join(" · "),
                    count: names.length - 2,
                  })
            }
            aside={null}
            verb={null}
            time={workflowStepTime(Math.max(0, row.endMs - row.startMs))}
            onPress={() => props.onOpenStep(names[0] ?? "")}
          />
        ),
      });
      continue;
    }
    if (row.kind === "together") {
      const running = row.beats.filter((beat) => beat.status === "running").length;
      const working = row.beats.some(
        (beat) =>
          beat.status === "running" &&
          beat.kind !== "sleep" &&
          beat.kind !== "wait" &&
          beat.kind !== "queue",
      );
      const startMs = Math.min(...row.beats.map((beat) => beat.startMs));
      const endMs = Math.max(...row.beats.map((beat) => beat.endMs));
      items.push({
        key: row.beats[0]?.name ?? "together",
        startMs,
        branch: true,
        body: (
          <>
            <TimelineRow
              tone={
                row.beats.some(asks)
                  ? "input"
                  : working
                    ? "working"
                    : running > 0
                      ? "quiet"
                      : row.beats.some((beat) => beat.status === "failed")
                        ? "failed"
                        : "done"
              }
              palette={palette}
              name={gt("{count} in parallel", { count: row.beats.length })}
              aside={null}
              verb={working ? gt("{count} running", { count: running }) : null}
              time={running > 0 ? null : workflowStepTime(endMs - startMs)}
            />
            <BranchOut palette={palette} />
            <View>
              {row.beats.map((beat, index) => {
                const first = index === 0;
                const last = index === row.beats.length - 1;
                return (
                  <View key={beat.name}>
                    {first && last ? null : (
                      <View
                        pointerEvents="none"
                        className="absolute w-0.5 bg-border"
                        style={{
                          left: 38,
                          top: first ? SUB_ROW / 2 : 0,
                          ...(last ? { height: SUB_ROW / 2 } : { bottom: 0 }),
                        }}
                      />
                    )}
                    {last ? <BranchBack palette={palette} /> : null}
                    {beatRow(beat, true)}
                    {under(beat)}
                  </View>
                );
              })}
            </View>
          </>
        ),
      });
      continue;
    }
    items.push({
      key: row.name,
      startMs: row.startMs,
      body: (
        <>
          {beatRow(row)}
          {under(row)}
        </>
      ),
    });
  }
  for (const asked of props.loose) {
    items.push({
      key: asked.name,
      startMs: Date.parse(asked.askedAt),
      body: (
        <>
          <TimelineRow
            tone="input"
            palette={palette}
            name={asked.name}
            aside={null}
            verb={gt("Needs you", { $context: "workflow run status: it waits on a person" })}
            verbTone="input"
            time={null}
          />
          <View className="mt-1 mb-2 ms-8">{props.renderQuestion(asked)}</View>
        </>
      ),
    });
  }
  if (run.status === "paused" && props.pausedAt === null) {
    items.push({
      key: "pause",
      startMs: Date.parse(run.updatedAt),
      body: (
        <>
          <TimelineRow
            tone="failed"
            palette={palette}
            name={gt("Paused", { $context: "workflow run status" })}
            aside={null}
            verb={null}
            time={null}
          />
          <View className="mt-1 mb-2 ms-8">{props.pause}</View>
        </>
      ),
    });
  }
  const ended = run.endedAt !== null;
  // A finished run needs no closing row; one that stopped another way says how.
  if (ended && run.status !== "completed") {
    items.push({
      key: "end",
      startMs: Date.parse(run.endedAt),
      body: (
        <TimelineRow
          tone="ended"
          palette={palette}
          name={
            run.status === "stopped"
              ? gt("Stopped", { $context: "how a workflow run ended" })
              : run.status === "skipped"
                ? gt("Skipped", { $context: "how a workflow run ended" })
                : gt("Cancelled", { $context: "how a workflow run ended" })
          }
          aside={run.detail}
          verb={null}
          time={null}
        />
      ),
    });
  }

  return (
    <View>
      {items.map((item, index) => (
        <Animated.View key={item.key} entering={enters(item.startMs)}>
          <Rail
            first={index === 0}
            last={item.branch === true || (index === items.length - 1 && ended)}
          />
          {item.body}
        </Animated.View>
      ))}
      {ended ? null : (
        <View
          pointerEvents="none"
          className="h-5 w-0 border-l-2 border-dashed border-border"
          style={{ marginLeft: 9 }}
        />
      )}
    </View>
  );
}
