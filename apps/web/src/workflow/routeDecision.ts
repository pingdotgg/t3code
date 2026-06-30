export interface RouteDecisionStepView {
  readonly status: string;
  readonly exitCode?: number | undefined;
  readonly verdict?: string | undefined;
}

export interface RouteDecisionView {
  readonly occurredAt: string;
  readonly fromLane?: string | undefined;
  readonly toLane: string;
  readonly source:
    | "step_on"
    | "lane_transition"
    | "lane_on"
    | "manual"
    | "external_event"
    | "work_source";
  readonly matchedTransitionIndex?: number | undefined;
  readonly eventName?: string | undefined;
  readonly pipelineResult?: "success" | "failure" | "blocked" | undefined;
  readonly laneRunCount?: number | undefined;
  readonly steps?: Readonly<Record<string, RouteDecisionStepView>> | undefined;
}

export interface DescribedRouteDecision {
  readonly title: string;
  readonly details: ReadonlyArray<string>;
}

/** A captured review output's verdict field, when it has the common shape. */
export const extractVerdict = (output: unknown): string | null => {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return null;
  }
  const verdict = (output as Record<string, unknown>)["verdict"];
  return typeof verdict === "string" ? verdict : null;
};

/** Agent-produced labels can be arbitrarily long — bound them for badges. */
export const truncateLabel = (value: string, maxLength = 48): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

const PIPELINE_RESULT_LABELS: Record<string, string> = {
  success: "Pipeline succeeded",
  failure: "Pipeline failed",
  blocked: "Pipeline blocked",
};

/**
 * Human-readable explanation of one routing decision for the ticket drawer.
 * `laneName` resolves lane keys to display names (falls back to the key).
 */
export const describeRouteDecision = (
  decision: RouteDecisionView,
  laneName: (key: string) => string,
): DescribedRouteDecision => {
  const to = laneName(decision.toLane);
  const title =
    decision.fromLane === undefined ? `Moved to ${to}` : `${laneName(decision.fromLane)} → ${to}`;

  if (decision.source === "manual") {
    return { title, details: ["Moved manually"] };
  }

  const details: string[] = [];
  if (decision.source === "lane_transition" && decision.matchedTransitionIndex !== undefined) {
    details.push(`Matched transition #${decision.matchedTransitionIndex + 1}`);
  } else if (decision.source === "lane_transition") {
    details.push("Matched a lane transition");
  } else if (decision.source === "lane_on") {
    details.push("Default route");
  } else if (decision.source === "external_event") {
    details.push(
      decision.eventName === undefined
        ? "External event"
        : // Truncate the name only, then wrap in quotes, so a long name never
          // drops the closing quote (which would be the truncated character).
          `External event "${truncateLabel(decision.eventName, 30)}"`,
    );
  } else if (decision.source === "work_source") {
    details.push("Synced from a work source");
  } else {
    details.push("Routed by a step outcome");
  }
  const resultLabel =
    decision.pipelineResult === undefined
      ? undefined
      : PIPELINE_RESULT_LABELS[decision.pipelineResult];
  if (resultLabel !== undefined) {
    details.push(resultLabel);
  }
  if (decision.laneRunCount !== undefined) {
    details.push(`Run ${decision.laneRunCount} in this lane`);
  }
  for (const [stepKey, step] of Object.entries(decision.steps ?? {})) {
    if (step.verdict !== undefined) {
      details.push(truncateLabel(`${stepKey}: ${step.verdict}`));
    } else if (step.exitCode !== undefined) {
      details.push(`${stepKey}: exit ${step.exitCode}`);
    }
  }
  return { title, details };
};
