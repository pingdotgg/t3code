import type { ClientSettings, InterfaceLayout } from "@t3tools/contracts";

import {
  INTERFACE_SURFACES,
  type InterfaceSurfaceId,
  resolveSurfaceLayout,
  setSurfaceElementHidden,
} from "../../interfaceLayout";

/** The settings a preset decides. Everything else is left as the user set it. */
export type PresetSettings = Pick<
  ClientSettings,
  "interfaceLayout" | "chatWidth" | "contextWindowMeterEnabled"
>;

export type PresetId = "balanced" | "minimal" | "focus" | "detailed";

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  readonly settings: PresetSettings;
}

type HiddenBySurface = Partial<Record<InterfaceSurfaceId, ReadonlyArray<string>>>;

function layoutHiding(hidden: HiddenBySurface): InterfaceLayout {
  let layout: InterfaceLayout = {};
  for (const [surface, ids] of Object.entries(hidden) as Array<
    [InterfaceSurfaceId, ReadonlyArray<string>]
  >) {
    for (const id of ids) layout = setSurfaceElementHidden(layout, surface, id, true);
  }
  return layout;
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    id: "balanced",
    label: "Balanced",
    description: "The standard layout",
    settings: { interfaceLayout: {}, chatWidth: "comfortable", contextWindowMeterEnabled: false },
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Titles and status",
    settings: {
      interfaceLayout: layoutHiding({
        threadRow: ["project", "branch", "terminal", "environment"],
        chatHeader: ["scripts"],
        composerToolbar: ["traits"],
      }),
      chatWidth: "comfortable",
      contextWindowMeterEnabled: false,
    },
  },
  {
    id: "focus",
    label: "Focus",
    description: "Quiet chrome",
    settings: {
      interfaceLayout: layoutHiding({
        threadRow: ["project", "branch", "terminal", "pullRequest", "environment"],
        chatHeader: ["scripts", "openIn"],
      }),
      chatWidth: "comfortable",
      contextWindowMeterEnabled: false,
    },
  },
  {
    id: "detailed",
    label: "Detailed",
    description: "Everything, full width",
    settings: { interfaceLayout: {}, chatWidth: "full", contextWindowMeterEnabled: true },
  },
];

const SURFACE_IDS = Object.keys(INTERFACE_SURFACES) as InterfaceSurfaceId[];

function sameLayout(a: InterfaceLayout, b: InterfaceLayout): boolean {
  return SURFACE_IDS.every((surface) => {
    const left = resolveSurfaceLayout(surface, a);
    const right = resolveSurfaceLayout(surface, b);
    return (
      left.order.every((id, index) => id === right.order[index]) &&
      left.hidden.size === right.hidden.size &&
      [...left.hidden].every((id) => right.hidden.has(id))
    );
  });
}

/** The preset the settings currently match, or null for a custom arrangement. */
export function matchPreset(settings: PresetSettings): PresetId | null {
  const match = PRESETS.find(
    (preset) =>
      preset.settings.chatWidth === settings.chatWidth &&
      preset.settings.contextWindowMeterEnabled === settings.contextWindowMeterEnabled &&
      sameLayout(preset.settings.interfaceLayout, settings.interfaceLayout),
  );
  return match?.id ?? null;
}

/** Resolve a transient preview without changing the saved settings. */
export function resolvePresetPreview<K extends keyof PresetSettings>(
  key: K,
  current: PresetSettings[K],
  active: boolean,
  previewId: PresetId | null,
): PresetSettings[K] {
  return active
    ? (PRESETS.find((preset) => preset.id === previewId)?.settings[key] ?? current)
    : current;
}

/** Shown and total element counts for a surface, for the fine-tune summaries. */
export function surfaceVisibility(
  surface: InterfaceSurfaceId,
  layout: InterfaceLayout,
): { shown: number; total: number } {
  const total = INTERFACE_SURFACES[surface].length;
  return { shown: total - resolveSurfaceLayout(surface, layout).hidden.size, total };
}
