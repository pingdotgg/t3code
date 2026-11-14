import { modelChipIcon } from "../lib/contextChipIconSource";
import { useContext, useMemo } from "react";
import { Image, Platform, useWindowDimensions } from "react-native";
import type { LinkPillContent, MarkdownStyle } from "react-native-enriched-markdown";
import type { ComposerContextRecord } from "@t3tools/contracts";
import { contextChipAccent, contextChipPresentation } from "../lib/composerChipPresentation";
import { CONTEXT_CHIP_ICON_SOURCES } from "../lib/contextChipIcons.generated";
import { FONT_FAMILIES } from "../lib/fontFamilies";
import { contextChipIconSource } from "../lib/contextChipIconSource";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIcon } from "../lib/markdownLinkIcons";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { resolveMarkdownFileIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import type {
  MarkdownLinkCustomization,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedModelReference,
  enrichedSkillReference,
  enrichedThreadLinkPresentation,
} from "../lib/enrichedLinkPresentation";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { MarkdownImageAvailableWidthContext } from "../features/threads/ThreadMarkdownImage";
import { markdownLinkChipReserves } from "../lib/markdownDocument";

function chipCustomization(
  chip: ReturnType<typeof enrichedContextLinkPresentation>,
): MarkdownLinkCustomization | undefined {
  if (!chip) return undefined;
  return {
    label: chip.label,
    icon: contextChipIconSource(chip.icon),
    chip: { accent: chip.accent, tintsIcon: chip.icon.kind === "chip" },
  };
}

export function enrichedContextLinkCustomization(
  href: string,
  records?: ReadonlyArray<ComposerContextRecord>,
) {
  return chipCustomization(enrichedContextLinkPresentation(href, records));
}

export function enrichedThreadLinkCustomization(href: string) {
  return chipCustomization(enrichedThreadLinkPresentation(href));
}

export function withChipIcon(
  customization: MarkdownLinkCustomization | undefined,
  iconUri: string | undefined,
): MarkdownLinkCustomization | undefined {
  return iconUri && customization?.chip
    ? {
        ...customization,
        icon: { uri: iconUri },
        chip: { ...customization.chip, tintsIcon: false },
      }
    : customization;
}

function presentation(
  url: string,
  props: Pick<SelectableMarkdownTextProps, "linkCustomization" | "skills" | "models" | "textStyle">,
): MarkdownLinkCustomization | undefined {
  const custom = props.linkCustomization?.(url);
  if (custom) return custom;
  const context = enrichedContextLinkCustomization(url);
  if (context) return context;
  const skill = enrichedSkillReference(url, props.skills);
  if (skill)
    return {
      label: formatProviderSkillDisplayName(skill),
      icon: CONTEXT_CHIP_ICON_SOURCES.skill,
      chip: { accent: contextChipPresentation("skill").accent, tintsIcon: true },
    };
  const model = enrichedModelReference(url, props.models);
  if (model) {
    const icon = modelChipIcon(model);
    return {
      label: model.label,
      icon: icon.source,
      chip: {
        accent: icon.accent,
        tintsIcon: icon.tintsIcon,
      },
    };
  }
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      label: link.label,
      icon: markdownFileIconSource(link.icon),
      chip: { accent: contextChipPresentation("mention").accent, tintsIcon: false },
    };
  const icon = link.kind === "external" ? markdownLinkIcon(link.host) : null;
  return icon
    ? {
        color: props.textStyle.linkColor,
        icon: icon.source,
        ...(icon.tints ? { iconTintColor: props.textStyle.linkColor } : {}),
      }
    : undefined;
}

export function useEnrichedLinkVariants(
  urls: ReadonlyArray<string>,
  props: SelectableMarkdownTextProps,
  fileHrefs: ReadonlySet<string>,
  markdown: string,
) {
  const { linkCustomization, skills, models, textStyle, fileEmbedLabel } = props;
  const theme = useUniwindTheme();
  const lineWidth = useContext(MarkdownImageAvailableWidthContext);
  const { fontScale } = useWindowDimensions();
  // Android moves a link chip down only if it fits with the text stuck to it (a closing "."), so
  // a chip as wide as the line runs off the edge.
  const pillMaxWidthKey = useMemo(() => {
    if (Platform.OS !== "android" || lineWidth <= 0 || urls.length === 0) return "[]";
    const em = textStyle.fontSize * fontScale;
    const reserves = markdownLinkChipReserves(markdown, urls, em);
    return JSON.stringify(
      urls.map((url) => {
        const reserve = reserves.get(url) ?? 2 * em;
        // Never zero, which the renderer reads as no cap.
        return [url, reserve && Math.max(lineWidth - reserve, em)];
      }),
    );
  }, [markdown, urls, lineWidth, textStyle.fontSize, fontScale]);
  // Parsed from a string so a streaming tick that changes no width keeps linkVariants.
  const pillMaxWidths = useMemo(
    () => new Map<string, number>(JSON.parse(pillMaxWidthKey)),
    [pillMaxWidthKey],
  );
  const links = useMemo(() => {
    const byUrl = new Map<string, MarkdownLinkCustomization>();
    for (const url of urls) {
      if (byUrl.has(url)) continue;
      const label = fileHrefs.has(url) ? fileEmbedLabel?.(url, false) : null;
      const value = label
        ? {
            label,
            color: textStyle.fileTextColor,
            icon: markdownFileIconSource(resolveMarkdownFileIcon(label)),
          }
        : presentation(url, { linkCustomization, skills, models, textStyle });
      if (value) byUrl.set(url, value);
    }
    return byUrl;
  }, [urls, linkCustomization, skills, models, textStyle, fileHrefs, fileEmbedLabel]);
  const chipForegrounds = useMemo(
    () =>
      new Map(
        [...links].map(([url, link]) => [
          url,
          link.chip
            ? (contextChipAccent(link.chip.accent, theme, textStyle.color) ?? textStyle.color)
            : undefined,
        ]),
      ),
    [links, textStyle, theme],
  );
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const chipForeground = chipForegrounds.get(url);
          const maxWidth = pillMaxWidths.get(url) ?? 0;
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: {
                borderColor: "transparent",
                borderWidth: 0,
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
                ...(maxWidth > 0 ? { maxWidth } : {}),
              },
              fontFamily: chipForeground ? FONT_FAMILIES.medium : textStyle.fontFamily,
              color: chipForeground ?? link.color ?? textStyle.fileTextColor,
              underline: false,
              backgroundColor: "transparent",
            },
          ];
        }),
      ),
    [chipForegrounds, links, textStyle, pillMaxWidths],
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
