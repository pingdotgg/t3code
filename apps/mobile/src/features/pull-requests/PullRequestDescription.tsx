import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Image } from "expo-image";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";
import { nativeMarkdownWithHtml } from "@t3tools/mobile-markdown-text/markdown";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";

const COLLAPSED_HEIGHT = 240;

export function PullRequestDescription(props: {
  readonly markdown: string;
  readonly onCollapse: () => void;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const { expanded, onExpandedChange } = props;
  const [bodyHeight, setBodyHeight] = useState(0);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const openingUri = preview && "uri" in preview ? preview.uri : null;
  const { themeVariables: colors } = useAppearancePreferences();
  const content = useMemo(() => {
    const document = nativeMarkdownWithHtml(
      parseMarkdownWithOptions(props.markdown, { gfm: true, html: true, math: false }),
      (markdown) => parseMarkdownWithOptions(markdown, { gfm: true, html: false, math: false }),
    );
    return pullRequestDescriptionContent(document);
  }, [props.markdown]);
  const gallery = useMemo(
    () =>
      content.attachments.map((attachment) => ({
        kind: "image" as const,
        uri: attachment.uri,
        name: new URL(attachment.uri).pathname.split("/").pop() || "Image",
      })),
    [content],
  );
  const canCollapse = bodyHeight > COLLAPSED_HEIGHT;
  const collapsed = canCollapse && !expanded;
  return (
    <View className="gap-5">
      <View className="gap-3">
        <Text className="text-base font-t3-semibold">Description</Text>
        {props.markdown.trim() ? (
          <View className="overflow-hidden">
            <View
              style={{
                height: expanded ? bodyHeight : Math.min(bodyHeight, COLLAPSED_HEIGHT),
                overflow: "hidden",
              }}
            >
              {/* Measure the full body independently of the clipped viewport. */}
              <View
                style={{ position: "absolute", top: 0, left: 0, right: 0 }}
                onLayout={(event) => setBodyHeight(event.nativeEvent.layout.height)}
              >
                <PullRequestMarkdown markdown={props.markdown} />
              </View>
            </View>
            {collapsed ? (
              <View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { top: undefined, height: 80, zIndex: 1 }]}
              >
                <Svg width="100%" height={80}>
                  <Defs>
                    <LinearGradient
                      id="description-fade"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="80"
                      gradientUnits="userSpaceOnUse"
                    >
                      <Stop offset="0" stopColor={colors["--color-screen"]} stopOpacity={0} />
                      <Stop offset="0.5" stopColor={colors["--color-screen"]} stopOpacity={0.94} />
                      <Stop offset="0.72" stopColor={colors["--color-screen"]} stopOpacity={1} />
                      <Stop offset="1" stopColor={colors["--color-screen"]} stopOpacity={1} />
                    </LinearGradient>
                  </Defs>
                  <Rect width="100%" height="100%" fill="url(#description-fade)" />
                </Svg>
                <View
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: 44,
                    backgroundColor: colors["--color-screen"],
                  }}
                />
              </View>
            ) : null}
            {canCollapse ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={expanded ? "Collapse description" : "Expand description"}
                onPress={() => {
                  if (expanded) props.onCollapse();
                  onExpandedChange(!expanded);
                }}
                style={
                  collapsed
                    ? { position: "absolute", bottom: 2, left: 0, right: 0, height: 44, zIndex: 2 }
                    : undefined
                }
                className="min-h-11 flex-row items-center justify-center gap-1 py-2 active:opacity-70"
              >
                <Text className="text-xs font-t3-medium text-foreground">
                  {expanded ? "Show less" : "Show more"}
                </Text>
                <SymbolView
                  name={expanded ? "chevron.up" : "chevron.down"}
                  size={10}
                  tintColorClassName="accent-foreground"
                />
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Text className="text-sm text-foreground-muted">No description provided.</Text>
        )}
      </View>
      {content.attachments.length ? (
        <View className="gap-3">
          <Text className="text-base font-t3-semibold">Attachments</Text>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            scrollsToTop={false}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12 }}
          >
            {content.attachments.map((attachment) => (
              <Pressable
                key={attachment.uri}
                accessibilityRole="imagebutton"
                accessibilityLabel={`View attachment: ${attachment.caption}`}
                accessibilityState={{ busy: openingUri === attachment.uri }}
                disabled={preview !== null}
                onPress={() =>
                  setPreview({
                    kind: "image",
                    uri: attachment.uri,
                    name: gallery.find((item) => item.uri === attachment.uri)?.name ?? "Image",
                    gallery,
                  })
                }
                className="gap-2 active:opacity-70"
                style={{ width: 176 }}
              >
                <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
                  <Image
                    source={{ uri: attachment.uri }}
                    style={{ width: 174, height: 112 }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                  {openingUri === attachment.uri ? (
                    <View
                      pointerEvents="none"
                      style={StyleSheet.absoluteFill}
                      className="items-center justify-center bg-black/30"
                    >
                      <ActivityIndicator color="white" />
                    </View>
                  ) : null}
                </View>
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {attachment.caption}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}
