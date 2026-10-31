import {
  type ExecutionEnvironmentCapabilities,
  type PluginView,
  type PluginViewBundleInput,
  type PluginViewCallInput,
  type PluginViewProblem,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestIfSupported } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

/** One environment's plugin views, or `unsupported` for a server that cannot serve them. */
export type PluginViewsView =
  | { readonly _tag: "unsupported" }
  | {
      readonly _tag: "available";
      readonly views: ReadonlyArray<PluginView>;
      readonly problems: ReadonlyArray<PluginViewProblem>;
    };

const supportsPluginViews = (
  capabilities: Pick<ExecutionEnvironmentCapabilities, "pluginViews"> | null | undefined,
) => capabilities?.pluginViews === true;

/** The consented bytes of one view generation, from a server that serves views. */
export const readPluginViewBundle = (input: PluginViewBundleInput) =>
  requestIfSupported(WS_METHODS.pluginViewsReadBundle, input, supportsPluginViews);

/**
 * One call from a mounted view into its plugin. The host builds `input` from
 * its own binding of the mount, never from the view's message.
 */
export const callPluginView = (input: PluginViewCallInput) =>
  requestIfSupported(WS_METHODS.pluginViewsCall, input, supportsPluginViews);

export function createPluginViewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** A view's bundle. Keyed by environment, installation, generation and view, so it never goes stale. */
    bundle: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:plugin-views:bundle",
      execute: readPluginViewBundle,
      staleTimeMs: Number.POSITIVE_INFINITY,
    }),
  };
}
