import { requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";

import {
  agentActivityWidgetTimeline,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

let publication = Promise.resolve();
let latestAccountId: string | null = null;
let accountGeneration = 0;

export function publishAgentActivityWidget(
  source: AgentActivityWidgetSource,
  accountId: string | null,
) {
  if (latestAccountId !== accountId) {
    latestAccountId = accountId;
    accountGeneration++;
  }
  const generation = accountGeneration;
  const next = publication.then(async () => {
    if (!requireOptionalNativeModule("ExpoWidgets")) return;
    const { default: widget } = await import("./AgentActivityWidget");
    if (generation !== accountGeneration) return;
    if (accountId && (source.kind === "loading" || source.kind === "unavailable")) {
      const cached = await widget.getTimeline().catch(() => []);
      if (generation !== accountGeneration) return;
      if (
        cached.some(
          ({ props }) =>
            props?.accountId === accountId &&
            (props.activities?.length || props.supplementalActivities?.length),
        )
      ) {
        const { readWidgetUnsettledRows } = await import("./readWidgetUnsettledRows.ios");
        if (generation !== accountGeneration) return;
        const supplementalActivities = readWidgetUnsettledRows(cached[0]?.props.activities ?? []);
        if (
          cached.some(
            ({ props }) =>
              JSON.stringify(props.supplementalActivities ?? []) !==
              JSON.stringify(supplementalActivities),
          )
        ) {
          widget.updateTimeline(
            cached.map((entry) => ({
              ...entry,
              props: { ...entry.props, supplementalActivities },
            })),
          );
        }
        return;
      }
    }
    const supplementalActivities =
      source.kind === "snapshot" && accountId
        ? (await import("./readWidgetUnsettledRows.ios")).readWidgetUnsettledRows(
            source.aggregate?.activities ?? [],
          )
        : [];
    if (generation !== accountGeneration) return;
    widget.updateTimeline(
      agentActivityWidgetTimeline(source, Date.now(), supplementalActivities).map((entry) => ({
        ...entry,
        props: {
          ...entry.props,
          source: source.kind,
          supplementalActivities: entry.props.supplementalActivities ?? [],
          baseUrl: Linking.createURL("/"),
          ...(source.kind === "snapshot" && accountId ? { accountId } : {}),
        },
      })),
    );
  });
  // Failed native writes must not prevent a later sign-out from clearing the timeline.
  publication = next.catch(() => {});
  return next;
}
