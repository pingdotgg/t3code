import { Button, Column, getMaterialColors, Row, Text } from "@expo/ui/jetpack-compose";
import { fillMaxSize, fillMaxWidth, padding, paddingAll } from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { AgentActivityPhase } from "./AgentActivity";
import type { AgentActivityWidgetSnapshot } from "./agentActivityWidgetTimeline";

// Android counterpart of the iOS Agent Activity widget. The publisher sorts
// the rows, so the first one is the thread that most needs the user.
export function AgentActivityWidget(
  publishedProps: Partial<AgentActivityWidgetSnapshot> | undefined,
  environment: WidgetEnvironment,
) {
  "widget";
  // The widget runtime evaluates this function without the app's module scope.
  // Before the app's first publish, the embedded layout renders with no props.
  const props = publishedProps ?? {};
  const dark = environment.colorScheme === "dark";
  const colors = getMaterialColors({ scheme: dark ? "dark" : "light" });
  const muted = colors.onSurfaceVariant;
  const phaseColor = (phase: AgentActivityPhase): string => {
    switch (phase) {
      case "waiting_for_approval":
        return dark ? "#fcd34d" : "#b45309";
      case "waiting_for_input":
        return dark ? "#a5b4fc" : "#4f46e5";
      case "failed":
        return dark ? "#fca5a5" : "#dc2626";
      case "completed":
        return dark ? "#6ee7b7" : "#047857";
      case "stale":
        return muted;
      case "starting":
      case "running":
      default:
        return dark ? "#7dd3fc" : "#0369a1";
    }
  };

  const loaded = props.activities !== undefined;
  // Android has no timeline; an expiry alarm re-renders this layout at `stale.at`.
  const rows =
    props.stale && Date.now() >= props.stale.at ? props.stale.activities : (props.activities ?? []);
  const attentionCount = rows.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  ).length;
  const workingCount = rows.filter(
    (row) => row.phase === "running" || row.phase === "starting",
  ).length;
  const summary =
    attentionCount > 0
      ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`
      : workingCount > 0
        ? `${workingCount} active`
        : rows.some((row) => row.phase === "stale")
          ? "Out of date"
          : rows.some((row) => row.phase === "failed")
            ? "Failed"
            : rows.length > 0
              ? "Done"
              : "T3 Code";
  const limit = 4;
  const hidden = rows.length - limit;

  return (
    // Android lacks widgetURL; one card Button routes taps to the app listener.
    <Button
      colors={{ containerColor: colors.surface }}
      modifiers={[fillMaxSize()]}
      onClick={() => {}}
    >
      <Column modifiers={[fillMaxSize(), paddingAll(16)]}>
        <Text
          color={rows[0] ? phaseColor(rows[0].phase) : colors.onSurface}
          maxLines={1}
          style={{ fontSize: 13, fontWeight: "bold" }}
        >
          {summary}
        </Text>
        {rows.length === 0 ? (
          <Text
            color={muted}
            maxLines={2}
            style={{ fontSize: 12 }}
            modifiers={[padding(0, 6, 0, 0)]}
          >
            {loaded
              ? (props.subtitle ?? "No active agents")
              : "Open T3 Code to load agent activity"}
          </Text>
        ) : null}
        {rows.slice(0, limit).map((row) => (
          // The title comes last so it, not the status, truncates on a narrow widget.
          <Row
            key={`${row.environmentId}:${row.threadId}`}
            modifiers={[fillMaxWidth(), padding(0, 6, 0, 0)]}
          >
            <Text
              color={phaseColor(row.phase)}
              maxLines={1}
              style={{ fontSize: 12, fontWeight: "bold" }}
            >
              {row.status}
            </Text>
            <Text
              color={colors.onSurface}
              maxLines={1}
              style={{ fontSize: 12 }}
              modifiers={[padding(8, 0, 0, 0)]}
            >
              {row.threadTitle}
            </Text>
          </Row>
        ))}
        {hidden > 0 ? (
          <Text
            color={muted}
            maxLines={1}
            style={{ fontSize: 11 }}
            modifiers={[padding(0, 6, 0, 0)]}
          >
            {`${hidden} more in T3`}
          </Text>
        ) : null}
      </Column>
    </Button>
  );
}

export default createWidget<Partial<AgentActivityWidgetSnapshot>>(
  "AgentActivity",
  AgentActivityWidget,
);
