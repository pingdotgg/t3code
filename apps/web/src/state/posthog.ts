import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** PostHog reads go through the server, which holds the API key. */
export const postHogEnvironment = {
  reports: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:posthog:reports",
    tag: WS_METHODS.posthogReportsList,
    staleTimeMs: 30_000,
  }),
  // A report's artefacts and signals are append-only and change on the order
  // of hours, while every read costs a round trip out to PostHog. Holding them
  // longer is what makes moving between reports feel local.
  artefacts: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:posthog:artefacts",
    tag: WS_METHODS.posthogReportArtefacts,
    staleTimeMs: 300_000,
  }),
  signals: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:posthog:signals",
    tag: WS_METHODS.posthogReportSignals,
    staleTimeMs: 300_000,
  }),
  setReportState: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:posthog:set-report-state",
    tag: WS_METHODS.posthogSetReportState,
  }),
};

// Every status the app can show, so one fetch feeds the inbox, the Done list,
// and the report header on a thread.
const REPORT_LIST_STATUSES =
  "ready,pending_input,potential,candidate,in_progress,failed,resolved,suppressed";

export function reportsListAtom(environmentId: EnvironmentId) {
  // Deliberately unfiltered by actionability. PostHog's `actionability` query
  // param drops reports that have no judgment yet, which is every report the
  // agent is still researching — the whole Watching section. The
  // not-actionable rule is applied client-side instead, where it can exclude
  // a value without also excluding an absence.
  return postHogEnvironment.reports({
    environmentId,
    input: { status: REPORT_LIST_STATUSES, limit: 200 },
  });
}
