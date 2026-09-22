import { Asset } from "expo-asset";
import { useEffect, useMemo, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import type { MarkdownDocumentAsset, MarkdownStyle } from "react-native-enriched-markdown";
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

// Native pill drawing accepts local image URIs. Expo resolves bundled PNGs once,
// including Metro's HTTP asset sources during development.
const localIconUris = new Map<number, string>();
const iconDownloads = new Map<number, Promise<string | null>>();

function localIconUri(source: number) {
  const cached = localIconUris.get(source);
  if (cached) return Promise.resolve(cached);
  const existing = iconDownloads.get(source);
  if (existing) return existing;
  const download = Asset.fromModule(source)
    .downloadAsync()
    .then((asset) => {
      if (asset.localUri) localIconUris.set(source, asset.localUri);
      return asset.localUri;
    })
    .catch(() => {
      iconDownloads.delete(source);
      return null;
    });
  iconDownloads.set(source, download);
  return download;
}

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

function iconUri(source: ImageSourcePropType | undefined, downloaded: ReadonlyMap<number, string>) {
  if (typeof source === "number") return downloaded.get(source);
  if (source && !Array.isArray(source) && "uri" in source && source.uri?.startsWith("file://")) {
    return source.uri;
  }
  return undefined;
}

export function useEnrichedLinkVariants(
  assets: ReadonlyArray<MarkdownDocumentAsset>,
  props: SelectableMarkdownTextProps,
): MarkdownStyle["linkVariants"] {
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
  const sourceKey = [
    ...new Set(
      [...links.values()].flatMap((link) => (typeof link.icon === "number" ? [link.icon] : [])),
    ),
  ]
    .sort((a, b) => a - b)
    .join(",");
  const [downloaded, setDownloaded] = useState(() => new Map(localIconUris));
  useEffect(() => {
    let cancelled = false;
    const sources = sourceKey ? sourceKey.split(",").map(Number) : [];
    const missing = sources.filter((source) => !localIconUris.has(source));
    if (sources.length === 0) return;
    void Promise.all(missing.map(localIconUri)).then(() => {
      if (!cancelled)
        setDownloaded((previous) =>
          sources.every((source) => previous.get(source) === localIconUris.get(source))
            ? previous
            : new Map(localIconUris),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [sourceKey]);

  return useMemo(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const color = link.color ?? props.textStyle.fileTextColor;
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: true,
              label: link.label,
              iconUri: iconUri(link.icon, downloaded),
              iconTintColor: link.iconTintColor,
              fontFamily: props.textStyle.fontFamily,
              color,
              underline: false,
              backgroundColor: themeColorWithAlpha(color, 0.08),
              borderColor:
                props.textStyle.contextChipBorderColor ?? themeColorWithAlpha(color, 0.2),
              borderWidth: 0.5,
              borderRadius: 6,
              paddingHorizontal: 5,
              paddingVertical: 2,
            },
          ];
        }),
      ),
    [links, downloaded, props.textStyle],
  );
}
