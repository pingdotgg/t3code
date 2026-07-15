import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { createElement, type FunctionComponent } from "react";
import type { PluginMessageActionRenderProps } from "@t3tools/plugin-sdk-web";

import { PluginSurfaceErrorBoundary, pluginUiRegistryAtom } from "./PluginUiHost";

export interface PluginMessageActionsProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Render the message actions registered by web plugins into a chat message's action
 * row, beside Copy.
 *
 * Each plugin returns its own trigger and manages its own UI; the host supplies the
 * message context and a mode-correct route base so a plugin can navigate to its own
 * routes afterwards. A plugin scopes itself by returning null — that is why the host
 * has no filter vocabulary here ("assistant only", "has a diff"): every such rule
 * would be one the host then has to maintain and a plugin would immediately want to
 * bend.
 *
 * Every action is wrapped individually, so one plugin's broken render cannot take
 * down the message — let alone the chat around it.
 */
export function PluginMessageActions({
  environmentId,
  threadId,
  messageId,
  role,
  text,
}: PluginMessageActionsProps) {
  const snapshot = useAtomValue(pluginUiRegistryAtom);
  const router = useRouter();
  const actions = snapshot.messageActions;

  if (actions.length === 0) {
    return null;
  }

  return (
    <>
      {actions.map((action) => {
        // Mode-correct route base (hash history on desktop, browser history on web),
        // matching what project actions get.
        const routeBasePath = router.history.createHref(`/${environmentId}/p/${action.pluginId}`);
        return (
          <PluginSurfaceErrorBoundary
            key={`${action.pluginId}:${action.id}`}
            label={`message-action:${action.pluginId}:${action.id}`}
            resetKey={action.render}
          >
            {createElement(action.render as FunctionComponent<PluginMessageActionRenderProps>, {
              pluginId: action.pluginId,
              threadId,
              messageId,
              role,
              text,
              routeBasePath,
            })}
          </PluginSurfaceErrorBoundary>
        );
      })}
    </>
  );
}
