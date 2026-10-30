import type { ContextChipIconRef } from "./composerChipPresentation";
import { CONTEXT_CHIP_ICON_SOURCES } from "./contextChipIcons.generated";
import { markdownFileIconSource, markdownIconAssetUri } from "./markdownFileIcons";

export function contextChipIconSource(icon: ContextChipIconRef) {
  return icon.kind === "chip"
    ? CONTEXT_CHIP_ICON_SOURCES[icon.name]
    : markdownFileIconSource(icon.name);
}

export function contextChipIconUri(icon: ContextChipIconRef): string | null {
  return markdownIconAssetUri(contextChipIconSource(icon)) ?? null;
}
