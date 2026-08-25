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
  artefacts: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:posthog:artefacts",
    tag: WS_METHODS.posthogReportArtefacts,
    staleTimeMs: 30_000,
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
  return postHogEnvironment.reports({
    environmentId,
    input: { status: REPORT_LIST_STATUSES, limit: 200 },
  });
}
