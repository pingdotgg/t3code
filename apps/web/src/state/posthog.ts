import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** PostHog reads go through the server, which holds the API key. */
export const postHogEnvironment = {
  reports: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:posthog:reports",
    tag: WS_METHODS.posthogReportsList,
    staleTimeMs: 30_000,
  }),
  artefacts: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:posthog:artefacts",
    tag: WS_METHODS.posthogReportArtefacts,
    staleTimeMs: 30_000,
  }),
};

// The sidebar sections cover every status, archived included. The reports
// page reads the same atom so one fetch feeds both and a refresh on either
// side updates the other.
const REPORT_LIST_STATUSES = "ready,pending_input,in_progress,candidate,suppressed,resolved";

export function reportsListAtom(environmentId: EnvironmentId) {
  return postHogEnvironment.reports({
    environmentId,
    input: { status: REPORT_LIST_STATUSES, limit: 100 },
  });
}

export type ReportSection = "needs-you" | "in-progress" | "candidates" | "archived";

export function reportSectionForStatus(status: string): ReportSection {
  switch (status) {
    case "ready":
    case "pending_input":
      return "needs-you";
    case "in_progress":
      return "in-progress";
    case "candidate":
      return "candidates";
    default:
      return "archived";
  }
}
