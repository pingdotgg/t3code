import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

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
