import type { LucideIcon } from "lucide-react";
import { GamepadIcon, NotebookPen, TvIcon } from "lucide-react";

import type { RightPanelKind } from "./rightPanelStore";

/** Continuum's own right-panel surfaces, offered from the panel launcher and the command palette. */
export interface ContinuumSurface {
  readonly kind: Extract<RightPanelKind, "iwe" | "forge" | "entertainment">;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** The launcher menu's single-key shortcut; unique among the launcher's entries. */
  readonly shortcut: string;
}

export const CONTINUUM_SURFACES: ReadonlyArray<ContinuumSurface> = [
  {
    kind: "iwe",
    label: "Notes (IWE)",
    title: "Notes",
    description: "Search, read, and edit this project's IWE notes.",
    icon: NotebookPen,
    shortcut: "N",
  },
  {
    kind: "forge",
    label: "Forge",
    title: "Forge",
    description: "Game engines, Blender, assets, and game checkpoints for this project.",
    icon: GamepadIcon,
    shortcut: "G",
  },
  {
    kind: "entertainment",
    label: "Entertainment",
    title: "Entertainment",
    description: "Games, videos, and streaming in a resizable panel, apart from your work.",
    icon: TvIcon,
    shortcut: "E",
  },
];

export function continuumSurface(kind: ContinuumSurface["kind"]): ContinuumSurface {
  const surface = CONTINUUM_SURFACES.find((entry) => entry.kind === kind);
  if (!surface) throw new Error(`Unknown Continuum surface ${kind}`);
  return surface;
}
