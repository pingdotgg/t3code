import type { ReactNode } from "react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { toastManager } from "../components/ui/toast";
import { type PluginOwner, setPluginWebFailure } from "./pluginRegistry";

// Once per plugin start: a panel that breaks on every render would otherwise report each time.
const reported = new WeakSet<PluginOwner>();

// A plugin can throw anything, including a value that throws when made into text.
const errorText = (error: unknown) =>
  (error instanceof Error && typeof error.message === "string"
    ? error.message
    : typeof error === "string" && error !== ""
      ? error
      : "a value that isn't an Error"
  ).slice(0, 500);

const reportRenderFailure = (owner: PluginOwner, what: string, error: unknown) => {
  if (reported.has(owner)) return;
  reported.add(owner);
  const message = `${what} stopped with an error: ${errorText(error)}`;
  setPluginWebFailure(owner.environmentId, owner.pluginId, "web", message);
  toastManager.add({
    type: "error",
    title: `${owner.pluginName} hit an error`,
    description: `${what} stopped working where it failed, until the plugin reloads.`,
  });
};

/** `what` names the contribution for people, such as "Its panel Notes". */
export function PluginRenderBoundary(props: {
  readonly owner: PluginOwner;
  readonly what: string;
  readonly fallback: ReactNode;
  readonly resetKeys: ReadonlyArray<unknown>;
  readonly children: ReactNode;
}) {
  return (
    <RenderErrorBoundary
      resetKeys={props.resetKeys}
      fallback={props.fallback}
      onError={(error) => reportRenderFailure(props.owner, props.what, error)}
    >
      {props.children}
    </RenderErrorBoundary>
  );
}
