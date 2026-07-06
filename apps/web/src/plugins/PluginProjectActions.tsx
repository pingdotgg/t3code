import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { createElement, type FunctionComponent } from "react";
import type { PluginProjectActionRenderProps } from "@t3tools/plugin-sdk-web";

import { PluginSurfaceErrorBoundary, pluginUiRegistryAtom } from "./PluginUiHost";

export interface PluginProjectActionsProps {
  readonly environmentId: string;
  readonly projectId: string;
  readonly projectName: string;
}

/**
 * Render the per-project actions registered by web plugins inline in a project
 * row (alongside the built-in "New thread" button). Each plugin's `render`
 * returns its own trigger and manages its own UI; the host supplies project
 * context and a mode-correct route base for post-action navigation.
 */
export function PluginProjectActions({
  environmentId,
  projectId,
  projectName,
}: PluginProjectActionsProps) {
  const snapshot = useAtomValue(pluginUiRegistryAtom);
  const router = useRouter();
  const actions = snapshot.projectActions;

  if (actions.length === 0) {
    return null;
  }

  return (
    <>
      {actions.map((action) => {
        // Mode-correct route base (hash history on desktop, browser history on
        // web) so a plugin can navigate to its own routes after the action runs.
        const routeBasePath = router.history.createHref(`/${environmentId}/p/${action.pluginId}`);
        return (
          <PluginSurfaceErrorBoundary
            key={`${action.pluginId}:${action.id}`}
            label={`project-action:${action.pluginId}:${action.id}`}
            resetKey={action.render}
          >
            {createElement(action.render as FunctionComponent<PluginProjectActionRenderProps>, {
              pluginId: action.pluginId,
              environmentId,
              projectId,
              projectName,
              routeBasePath,
            })}
          </PluginSurfaceErrorBoundary>
        );
      })}
    </>
  );
}
