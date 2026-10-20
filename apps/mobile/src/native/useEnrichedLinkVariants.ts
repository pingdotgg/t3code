import { useMemo } from "react";
import { Image } from "react-native";
import type {
  LinkPillContent,
  MarkdownDocumentAsset,
  MarkdownStyle,
} from "react-native-enriched-markdown";
import type { ComposerContextRecord } from "@t3tools/contracts";
import { contextChipPresentation } from "../lib/composerChipPresentation";
import { CONTEXT_CHIP_ICON_SOURCES } from "../lib/contextChipIcons.generated";
import { FONT_FAMILIES } from "../lib/fontFamilies";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import type {
  MarkdownLinkCustomization,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillDisplayName,
  enrichedSkillReference,
  type EnrichedChipIcon,
} from "../lib/enrichedLinkPresentation";

function chipIconSource(icon: EnrichedChipIcon) {
  return icon.kind === "chip"
    ? CONTEXT_CHIP_ICON_SOURCES[icon.name]
    : markdownFileIconSource(icon.name);
}

export function enrichedContextLinkCustomization(
  href: string,
  records?: ReadonlyArray<ComposerContextRecord>,
): MarkdownLinkCustomization | undefined {
  const context = enrichedContextLinkPresentation(href, records);
  if (!context) return undefined;
  return {
    label: context.label,
    icon: chipIconSource(context.icon),
    chip: { accent: context.accent, tintsIcon: context.icon.kind === "chip" },
  };
}

function presentation(
  url: string,
  props: Pick<SelectableMarkdownTextProps, "linkCustomization" | "skills" | "textStyle">,
): MarkdownLinkCustomization | undefined {
  const custom = props.linkCustomization?.(url);
  if (custom) return custom;
  const context = enrichedContextLinkCustomization(url);
  if (context) return context;
  const skill = enrichedSkillReference(url, props.skills);
  if (skill)
    return {
      label: enrichedSkillDisplayName(skill),
      icon: CONTEXT_CHIP_ICON_SOURCES.skill,
      chip: { accent: contextChipPresentation("skill").accent, tintsIcon: true },
    };
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      label: link.label,
      icon: markdownFileIconSource(link.icon),
      chip: { accent: contextChipPresentation("mention").accent, tintsIcon: false },
    };
  const icon = link.kind === "external" ? resolveMarkdownLinkIcon(link.host) : null;
  return icon
    ? {
        color: props.textStyle.linkColor,
        icon: markdownLinkIconSource(icon),
        iconTintColor: props.textStyle.linkColor,
      }
    : undefined;
}

export function useEnrichedLinkVariants(
  assets: ReadonlyArray<MarkdownDocumentAsset>,
  props: SelectableMarkdownTextProps,
) {
  const { linkCustomization, skills, textStyle } = props;
  const links = useMemo(() => {
    const byUrl = new Map<string, MarkdownLinkCustomization>();
    for (const asset of assets) {
      if (asset.kind !== "link" || byUrl.has(asset.url)) continue;
      const value = presentation(asset.url, { linkCustomization, skills, textStyle });
      if (value) byUrl.set(asset.url, value);
    }
    return byUrl;
  }, [assets, linkCustomization, skills, textStyle]);
  const chipForegrounds = useMemo(
    () =>
      new Map(
        [...links].map(([url, link]) => [
          url,
          link.chip ? (link.chip.accent ?? textStyle.color) : undefined,
        ]),
      ),
    [links, textStyle],
  );
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const chipForeground = chipForegrounds.get(url);
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: {
                borderColor: "transparent",
                borderWidth: 0,
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
              },
              fontFamily: chipForeground ? FONT_FAMILIES.medium : textStyle.fontFamily,
              color: chipForeground ?? link.color ?? textStyle.fileTextColor,
              underline: false,
              backgroundColor: "transparent",
            },
          ];
        }),
      ),
    [chipForegrounds, links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          url,
          {
            label: link.label,
            iconUri: link.icon ? Image.resolveAssetSource(link.icon)?.uri : undefined,
            iconTintColor: link.chip?.tintsIcon ? chipForegrounds.get(url) : link.iconTintColor,
          },
        ]),
      ),
    [chipForegrounds, links],
  );
  return { linkVariants, linkPillContent };
}
