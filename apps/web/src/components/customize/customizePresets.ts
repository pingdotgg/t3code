import type { ClientSettings, InterfaceLayout } from "@t3tools/contracts";

import {
  INTERFACE_SURFACES,
  type InterfaceSurfaceId,
  resolveSurfaceLayout,
  setSurfaceElementHidden,
} from "../../interfaceLayout";

/** Settings read by clients during a layout preview. */
export type PresetSettings = Pick<
  ClientSettings,
  "interfaceLayout" | "chatWidth" | "contextWindowMeterEnabled"
>;

export type PresetId = "balanced" | "minimal" | "focus" | "detailed";

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  readonly settings: Pick<PresetSettings, "interfaceLayout">;
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
    description: "Everyday details",
    settings: { interfaceLayout: layoutHiding({ threadRow: ["terminal", "environment"] }) },
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
    },
  },
  {
    id: "focus",
    label: "Focus",
    description: "Quiet chrome",
    settings: {
      interfaceLayout: layoutHiding({
        threadRow: [
          "project",
          "status",
          "branch",
          "terminal",
          "pullRequest",
          "environment",
          "provider",
        ],
        chatHeader: ["scripts", "openIn", "git"],
        composerToolbar: ["traits", "mode"],
        composerContextBar: ["workspace", "branch"],
      }),
    },
  },
  {
    id: "detailed",
    label: "Detailed",
    description: "All details",
    settings: { interfaceLayout: {} },
  },
];

const SURFACE_IDS = Object.keys(INTERFACE_SURFACES) as InterfaceSurfaceId[];

/** Apply preset visibility while keeping saved order and unknown future elements. */
export function applyPresetLayout(
  current: InterfaceLayout,
  preset: InterfaceLayout,
): InterfaceLayout {
  if (sameVisibility(current, preset)) return current;
  const next = { ...current };
  for (const surface of SURFACE_IDS) {
    const knownIds = new Set<string>(INTERFACE_SURFACES[surface].map((element) => element.id));
    const hidden = [
      ...(current[surface]?.hidden ?? []).filter((id) => !knownIds.has(id)),
      ...resolveSurfaceLayout(surface, preset).hidden,
    ];
    const order = current[surface]?.order ?? [];
    if (order.length === 0 && hidden.length === 0) delete next[surface];
    else next[surface] = { ...current[surface], order, hidden };
  }
  return next;
}

function sameVisibility(a: InterfaceLayout, b: InterfaceLayout): boolean {
  return SURFACE_IDS.every((surface) => {
    const left = resolveSurfaceLayout(surface, a);
    const right = resolveSurfaceLayout(surface, b);
    return (
      left.hidden.size === right.hidden.size && [...left.hidden].every((id) => right.hidden.has(id))
    );
  });
}

/** Match only choices the preset makes; user ordering and meters are independent. */
export function matchPreset(settings: Pick<PresetSettings, "interfaceLayout">): PresetId | null {
  const match = PRESETS.find((preset) =>
    sameVisibility(preset.settings.interfaceLayout, settings.interfaceLayout),
  );
  return match?.id ?? null;
}

/** Resolve a transient preview without changing the saved settings. */
export function resolvePresetPreview<K extends keyof PresetSettings>(
  key: K,
  current: PresetSettings[K],
  previewId: PresetId | null,
): PresetSettings[K] {
  const preset = PRESETS.find((candidate) => candidate.id === previewId);
  if (!preset) return current;
  if (key === "interfaceLayout") {
    return applyPresetLayout(
      current as InterfaceLayout,
      preset.settings.interfaceLayout,
    ) as PresetSettings[K];
  }
  return current;
}

/** Shown and total element counts for a surface, for the fine-tune summaries. */
export function surfaceVisibility(
  surface: InterfaceSurfaceId,
  layout: InterfaceLayout,
): { shown: number; total: number } {
  const total = INTERFACE_SURFACES[surface].length;
  return { shown: total - resolveSurfaceLayout(surface, layout).hidden.size, total };
}
