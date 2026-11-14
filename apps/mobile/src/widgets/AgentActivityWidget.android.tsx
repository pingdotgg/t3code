import { Box, Button, Column, Row, Text } from "@expo/ui/jetpack-compose";
import { fillMaxSize, fillMaxWidth, padding, paddingAll } from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { AgentActivityPhase } from "./AgentActivity";
import type { AgentActivityWidgetSnapshot } from "./agentActivityWidgetTimeline";

// Android counterpart of the iOS Agent Activity widget, with the same header,
// row layout, and phase colors. The publisher sorts the rows, so the first one
// is the thread that most needs the user.
export function AgentActivityWidget(
  publishedProps: Partial<AgentActivityWidgetSnapshot> | undefined,
  environment: WidgetEnvironment,
) {
  "widget";
  // The widget runtime evaluates this function without the app's module scope.
  // Before the app's first publish, the embedded layout renders with no props.
  const props = publishedProps ?? {};
  const light = environment.colorScheme !== "dark";
  const background = light ? "#ffffff" : "#1c1c1e";
  const primary = light ? "#000000" : "#ffffff";
  const secondary = light ? "#8e8e93" : "#98989f";
  const phaseColor = (phase: AgentActivityPhase): string => {
    switch (phase) {
      case "waiting_for_approval":
        return light ? "#d97706" : "#fcd34d";
      case "waiting_for_input":
        return light ? "#4f46e5" : "#a5b4fc";
      case "failed":
        return light ? "#dc2626" : "#fca5a5";
      case "completed":
        return light ? "#059669" : "#6ee7b7";
      case "stale":
        return secondary;
      case "starting":
      case "running":
      default:
        return light ? "#0284c7" : "#7dd3fc";
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
        ? `${props.activeCount ?? workingCount} active`
        : rows.some((row) => row.phase === "stale")
          ? "Out of date"
          : rows.some((row) => row.phase === "failed")
            ? "Failed"
            : rows.length > 0
              ? "Done"
              : "";
  const shown = rows.slice(0, 4);

  return (
    // Android lacks widgetURL; one card Button routes taps to the app listener.
    <Button colors={{ containerColor: background }} modifiers={[fillMaxSize()]} onClick={() => {}}>
      <Column modifiers={[fillMaxSize(), paddingAll(16)]}>
        <Row modifiers={[fillMaxWidth()]}>
          <Text color={primary} maxLines={1} style={{ fontSize: 14, fontWeight: "900" }}>
            T3
          </Text>
          <Text
            color={rows[0] ? phaseColor(rows[0].phase) : secondary}
            maxLines={1}
            style={{ fontSize: 13, fontWeight: "bold" }}
            modifiers={[padding(7, 1, 0, 0)]}
          >
            {summary}
          </Text>
        </Row>
        {shown.length === 0 ? (
          <Text
            color={secondary}
            maxLines={2}
            style={{ fontSize: 13 }}
            modifiers={[padding(0, 8, 0, 0)]}
          >
            {loaded
              ? (props.subtitle ?? "No active agents")
              : "Open T3 Code to load agent activity"}
          </Text>
        ) : null}
        {shown.map((row) => (
          // The status sits on the right like iOS; the title stops short of it and truncates.
          // Glance has no layout weights, so a project label would be squeezed to ".."; it is left out.
          <Box
            key={`${row.environmentId}:${row.threadId}`}
            contentAlignment="centerStart"
            modifiers={[fillMaxWidth(), padding(0, 7, 0, 0)]}
          >
            <Text
              color={primary}
              maxLines={1}
              style={{ fontSize: 14, fontWeight: "bold" }}
              modifiers={[fillMaxWidth(), padding(0, 0, 96, 0)]}
            >
              {row.threadTitle}
            </Text>
            <Box contentAlignment="centerEnd" modifiers={[fillMaxWidth()]}>
              <Text
                color={phaseColor(row.phase)}
                maxLines={1}
                style={{ fontSize: 12, fontWeight: "bold" }}
              >
                {row.status}
              </Text>
            </Box>
          </Box>
        ))}
      </Column>
    </Button>
  );
}

export default createWidget<Partial<AgentActivityWidgetSnapshot>>(
  "AgentActivity",
  AgentActivityWidget,
);
