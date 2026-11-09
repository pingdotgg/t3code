import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";

import { MenuItem, MenuSeparator } from "../components/ui/menu";
import { useRightPanelStore } from "../rightPanelStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { pluginRightPanelsAtom } from "./pluginRegistry";

function usePluginPanelEntries(environmentId: EnvironmentId | null) {
  const panels = useAtomValue(pluginRightPanelsAtom(environmentId ?? ""));
  const target = resolveThreadRouteTarget(useParams({ strict: false }));
  if (target?.kind !== "server") return [];
  const threadRef = target.threadRef;
  return panels.map((panel) => ({
    key: `${panel.pluginId}:${panel.name}`,
    title: panel.title,
    open: () =>
      useRightPanelStore.getState().openPlugin(threadRef, {
        pluginId: panel.pluginId,
        panel: panel.name,
        title: panel.title,
      }),
  }));
}

export function PluginPanelMenuItems(props: {
  readonly environmentId: EnvironmentId | null;
  readonly onOpen: () => void;
}) {
  const entries = usePluginPanelEntries(props.environmentId);
  if (entries.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      {entries.map((entry) => (
        <MenuItem
          key={entry.key}
          onClick={() => {
            props.onOpen();
            entry.open();
          }}
        >
          <Puzzle />
          {entry.title}
        </MenuItem>
      ))}
    </>
  );
}

export function PluginPanelLauncherItems(props: { readonly environmentId: EnvironmentId | null }) {
  const entries = usePluginPanelEntries(props.environmentId);
  return entries.map((entry) => (
    <button
      key={entry.key}
      type="button"
      onClick={entry.open}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors hover:bg-accent/60"
    >
      <Puzzle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
    </button>
  ));
}
