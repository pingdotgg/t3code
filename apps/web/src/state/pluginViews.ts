import { useAtomValue } from "@effect/atom-react";
import { createPluginViewEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginViews";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  createSessionPluginViewsAtoms,
  currentSessionPluginViews,
  NO_SESSION_VIEWS,
  type SessionPluginViews,
} from "./pluginViewSessions";

export { sidePanelPluginViews } from "./pluginViewSessions";

export const pluginViewEnvironment = createPluginViewEnvironmentAtoms(connectionAtomRuntime);

const sessionPluginViews = createSessionPluginViewsAtoms(connectionAtomRuntime);

const NO_ENVIRONMENT_ATOM = Atom.make(AsyncResult.success(NO_SESSION_VIEWS)).pipe(
  Atom.withLabel("web-plugin-views:no-environment"),
);

/**
 * One environment's current session and the views that session offers, or
 * null views until it has answered. A server without the `pluginViews`
 * capability answers `unsupported` without a request.
 */
export function usePluginViews(environmentId: EnvironmentId | null): SessionPluginViews {
  return currentSessionPluginViews(
    useAtomValue(environmentId === null ? NO_ENVIRONMENT_ATOM : sessionPluginViews(environmentId)),
  );
}
