import { createPluginRegistry } from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { T } from "gt-react";
import { Suspense, useSyncExternalStore, type ComponentType } from "react";

import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import type { PreviewPanelMode } from "~/components/preview/PreviewPanelShell";
import { PluginSlot, pluginSharedState } from "./features";

export interface PluginPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly surface?: RightPanelSurface;
  readonly projectId?: ProjectId | null;
  readonly mode?: PreviewPanelMode;
  readonly visible?: boolean;
}

export interface PluginPanelContext {
  readonly threadRef?: ScopedThreadRef;
  readonly projectId: ProjectId | null;
}

export interface PluginPanelRegistration {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<PluginPanelProps>;
  readonly icon?: ComponentType<{ readonly className?: string }>;
  readonly description?: string;
  readonly shortcut?: string;
  readonly available?: (context: PluginPanelContext) => boolean;
  readonly unavailableReason?: string;
  /** A native descriptor preserves existing document tabs and stored panel state. */
  readonly surfaceKind?: "canvas";
}

export interface PluginPanelDescription extends Omit<PluginPanelRegistration, "id" | "component"> {
  readonly slot: string;
}

export const pluginPanels = pluginSharedState("panels", () =>
  createPluginRegistry<{ panels: PluginPanelDescription }>(),
);

export function usePluginPanels(environmentId: EnvironmentId | null) {
  const entries = useSyncExternalStore(
    pluginPanels.subscribe,
    () => pluginPanels.entries("panels"),
    () => pluginPanels.entries("panels"),
  );
  return entries
    .filter((entry) => entry.pluginId.startsWith(`${environmentId}:`))
    .map((entry) => entry.load());
}

export function openPluginPanel(threadRef: ScopedThreadRef, panel: PluginPanelDescription) {
  if (panel.surfaceKind === "canvas") {
    useRightPanelStore.getState().openCanvas(threadRef, null);
    return;
  }
  useRightPanelStore.getState().openPlugin(threadRef, panel.slot, panel.title);
}

function UnavailablePanel() {
  return (
    <p className="p-4 text-sm text-muted-foreground">
      <T>Enable the plugin to reopen this panel.</T>
    </p>
  );
}

export function PluginPanel(
  props: PluginPanelProps & {
    readonly surface: Extract<RightPanelSurface, { kind: "plugin" | "canvas" }>;
  },
) {
  const panels = usePluginPanels(props.threadRef.environmentId);
  const slot =
    props.surface.kind === "plugin"
      ? props.surface.slot
      : panels.find((panel) => panel.surfaceKind === props.surface.kind)?.slot;
  if (!slot) return <UnavailablePanel />;
  return (
    <Suspense
      fallback={
        <p className="p-4 text-sm text-muted-foreground">
          <T>Loading panel...</T>
        </p>
      }
    >
      <PluginSlot slot={slot} props={props} fallback={UnavailablePanel} />
    </Suspense>
  );
}
