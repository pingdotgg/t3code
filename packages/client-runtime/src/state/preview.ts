import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPreviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const statusScheduler = createAtomCommandScheduler();
  const automationScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:list",
      tag: WS_METHODS.previewList,
      staleTimeMs: 5_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:events",
      tag: WS_METHODS.subscribePreviewEvents,
    }),
    discoveredServers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:discovered-servers",
      tag: WS_METHODS.subscribeDiscoveredLocalServers,
    }),
    automationRequests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:automation-requests",
      tag: WS_METHODS.previewAutomationConnect,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:open",
      tag: WS_METHODS.previewOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:navigate",
      tag: WS_METHODS.previewNavigate,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:refresh",
      tag: WS_METHODS.previewRefresh,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:close",
      tag: WS_METHODS.previewClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    reportStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:report-status",
      tag: WS_METHODS.previewReportStatus,
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
    respondToAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-respond",
      tag: WS_METHODS.previewAutomationRespond,
      scheduler: automationScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.requestId]),
      },
    }),
    reportAutomationOwner: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-report-owner",
      tag: WS_METHODS.previewAutomationReportOwner,
      scheduler: automationScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.clientId]),
      },
    }),
    clearAutomationOwner: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-clear-owner",
      tag: WS_METHODS.previewAutomationClearOwner,
      scheduler: automationScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.clientId]),
      },
    }),
  };
}
