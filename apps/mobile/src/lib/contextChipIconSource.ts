import type { ContextChipIconRef } from "./composerChipPresentation";
import { CONTEXT_CHIP_ICON_SOURCES, PROVIDER_CHIP_ICONS } from "./contextChipIcons.generated";
import { markdownFileIconSource, markdownIconAssetUri } from "./markdownFileIcons";

export function contextChipIconSource(icon: ContextChipIconRef) {
  return icon.kind === "chip"
    ? CONTEXT_CHIP_ICON_SOURCES[icon.name]
    : markdownFileIconSource(icon.name);
}

export function contextChipIconUri(icon: ContextChipIconRef): string | null {
  return markdownIconAssetUri(contextChipIconSource(icon)) ?? null;
}

/** A registry agent's own image, else the provider's logo, else a generic glyph. */
export function modelChipIcon(model: {
  readonly driver: string;
  readonly iconUrl?: string | undefined;
}) {
  if (model.iconUrl) return { source: { uri: model.iconUrl }, tintsIcon: false };
  return (
    PROVIDER_CHIP_ICONS[model.driver] ?? { source: CONTEXT_CHIP_ICON_SOURCES.bot, tintsIcon: true }
  );
}

export function modelChipIconUri(model: Parameters<typeof modelChipIcon>[0]): string | null {
  return model.iconUrl ?? markdownIconAssetUri(modelChipIcon(model).source) ?? null;
}
