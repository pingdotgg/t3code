/**
 * Cloud as a place a thread runs, not a provider. A driver that has a cloud
 * (Codex, Claude) marks its snapshot with `withCloudRunOption` and wraps its
 * adapter with `withCloudRun`, so threads whose selection asks for the cloud
 * run their turns there while every other thread runs natively.
 *
 * @module provider-cloud/server/cloudRun
 */
import { selectedCloudEnvironment, selectsCloudRun, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

type AdapterService = ProviderAdapter.ProviderAdapterV2["Service"];

/** Offers the provider's cloud under Run on, named by `label`. */
export const withCloudRunOption = (
  snapshot: ServerProvider,
  label: string,
  requiresEnvironment = false,
): ServerProvider => ({
  ...snapshot,
  cloudRun: { label, ...(requiresEnvironment ? { requiresEnvironment } : {}) },
});

/**
 * Routes each session by its selection: cloud sessions open on the cloud
 * adapter, the rest on the native one. Like the machine a thread runs on, the
 * cloud choice is fixed once a session exists.
 */
export const withCloudRun = (native: AdapterService, cloud: AdapterService): AdapterService => ({
  ...native,
  // A cloud thread gets its own session: the native one may be shared by every thread.
  capabilitiesFor: (modelSelection) =>
    selectsCloudRun(modelSelection.options)
      ? (cloud.capabilitiesFor?.(modelSelection) ?? cloud.getCapabilities())
      : (native.capabilitiesFor?.(modelSelection) ?? native.getCapabilities()),
  planSelectionTransition: (input) => {
    const fromCloud = selectsCloudRun(input.current.options);
    if (fromCloud !== selectsCloudRun(input.target.options))
      return Effect.succeed({
        type: "reject",
        reason: fromCloud
          ? "This thread runs in the cloud. Start a new thread to run on a machine."
          : "This thread runs on a machine. Start a new thread to run in the cloud.",
      });
    if (
      fromCloud &&
      selectedCloudEnvironment(input.current.options) !==
        selectedCloudEnvironment(input.target.options)
    )
      return Effect.succeed({
        type: "reject",
        reason: "Start a new thread to change its cloud environment.",
      });
    return (fromCloud ? cloud : native).planSelectionTransition(input);
  },
  openSession: (input) =>
    selectsCloudRun(input.modelSelection.options)
      ? cloud.openSession(input)
      : native.openSession(input),
});
