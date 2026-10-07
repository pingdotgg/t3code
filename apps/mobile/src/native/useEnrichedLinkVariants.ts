import { useMemo } from "react";
import { Image } from "react-native";
import type {
  LinkPillContent,
  MarkdownDocumentAsset,
  MarkdownStyle,
} from "react-native-enriched-markdown";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillDisplayName,
} from "../lib/enrichedLinkPresentation";
import { themeColorWithAlpha } from "../lib/mobileTheme";

function presentation(
  url: string,
  props: Pick<SelectableMarkdownTextProps, "linkCustomization" | "skills" | "textStyle">,
) {
  const custom = props.linkCustomization?.(url);
  if (custom) return custom;
  const context = enrichedContextLinkPresentation(url);
  if (context) return { color: context.color, icon: markdownFileIconSource(context.icon) };
  const skill = url.startsWith("$")
    ? props.skills?.find((candidate) => `$${candidate.name}` === url)
    : undefined;
  if (skill)
    return {
      color: props.textStyle.skillTextColor,
      label: enrichedSkillDisplayName(skill),
      icon: markdownFileIconSource("mcp"),
    };
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      color: props.textStyle.fileTextColor,
      label: link.label,
      icon: markdownFileIconSource(link.icon),
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
    const byUrl = new Map<string, NonNullable<ReturnType<typeof presentation>>>();
    for (const asset of assets) {
      if (asset.kind !== "link" || byUrl.has(asset.url)) continue;
      const value = presentation(asset.url, { linkCustomization, skills, textStyle });
      if (value) byUrl.set(asset.url, value);
    }
    return byUrl;
  }, [assets, linkCustomization, skills, textStyle]);
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const color = link.color ?? textStyle.fileTextColor;
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: {
                borderColor: textStyle.contextChipBorderColor ?? themeColorWithAlpha(color, 0.2),
                borderWidth: 0.5,
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
              },
              fontFamily: textStyle.fontFamily,
              color,
              underline: false,
              backgroundColor: themeColorWithAlpha(color, 0.08),
            },
          ];
        }),
      ),
    [links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          url,
          {
            label: link.label,
            iconUri: link.icon ? Image.resolveAssetSource(link.icon)?.uri : undefined,
            iconTintColor: link.iconTintColor,
          },
        ]),
      ),
    [links],
  );
  return { linkVariants, linkPillContent };
}
