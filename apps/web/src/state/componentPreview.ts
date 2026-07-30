/**
 * RPC atoms for the component preview harness.
 *
 * Distinct from `preview.ts` (desktop webview browser preview). These wrap
 * the `componentPreview.*` WS methods with the shared environment RPC
 * command/subscription factories.
 */
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const scheduler = createAtomCommandScheduler();

export const componentPreviewEnvironment = {
  inspectProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:inspect-project",
    tag: WS_METHODS.componentPreviewInspectProject,
    scheduler,
  }),
  searchComponents: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:search-components",
    tag: WS_METHODS.componentPreviewSearchComponents,
    scheduler,
  }),
  resolveTarget: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:resolve-target",
    tag: WS_METHODS.componentPreviewResolveTarget,
    scheduler,
  }),
  prepareBootstrapThread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:prepare-bootstrap-thread",
    tag: WS_METHODS.componentPreviewPrepareBootstrapThread,
    scheduler,
  }),
  prepareGenerationTurn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:prepare-generation-turn",
    tag: WS_METHODS.componentPreviewPrepareGenerationTurn,
    scheduler,
  }),
  prepareRepairTurn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:prepare-repair-turn",
    tag: WS_METHODS.componentPreviewPrepareRepairTurn,
    scheduler,
  }),
  ensureRuntime: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:ensure-runtime",
    tag: WS_METHODS.componentPreviewEnsureRuntime,
    scheduler,
  }),
  issueAccessToken: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:issue-access-token",
    tag: WS_METHODS.componentPreviewIssueAccessToken,
    scheduler,
  }),
  stopRuntime: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:component-preview:stop-runtime",
    tag: WS_METHODS.componentPreviewStopRuntime,
    scheduler,
  }),
  projectEvents: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:component-preview:project-events",
    tag: WS_METHODS.subscribeComponentPreviewProject,
    // Runtime lifecycle events are commands to the surface, not cached query
    // data — dispose immediately with the owning surface.
    idleTtlMs: 0,
  }),
};
