import { requireOptionalNativeModule } from "expo";

import {
  agentActivityWidgetTimeline,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

let publication = Promise.resolve();

export function publishAgentActivityWidget(
  source: AgentActivityWidgetSource,
  accountId: string | null,
) {
  const next = publication.then(async () => {
    if (!requireOptionalNativeModule("ExpoWidgets")) return;
    const { default: widget } = await import("./AgentActivityWidget");
    if (accountId && (source.kind === "loading" || source.kind === "unavailable")) {
      const cached = await widget.getTimeline().catch(() => []);
      if (cached.some(({ props }) => props?.accountId === accountId && props.activities?.length)) {
        return;
      }
    }
    widget.updateTimeline(
      agentActivityWidgetTimeline(source, Date.now()).map((entry) => ({
        ...entry,
        props: {
          ...entry.props,
          ...(source.kind === "snapshot" && accountId ? { accountId } : {}),
        },
      })),
    );
  });
  // Failed native writes must not prevent a later sign-out from clearing the timeline.
  publication = next.catch(() => {});
  return next;
}
