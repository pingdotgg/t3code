import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";
import {
  PullRequestImageAttachment,
  PullRequestMedia,
  PullRequestMediaContext,
} from "./PullRequestMedia";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import { useContext, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { pullRequestImageSource } from "./pullRequestMediaSource";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";
import { nativeMarkdownWithHtml } from "@t3tools/mobile-markdown-text/markdown";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { FilePreviewItem } from "../../components/FilePreviewModal";
import { isBotBadgeImage } from "./botBadgeImages";
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
  const mediaContext = useContext(PullRequestMediaContext);
  const { themeVariables: colors } = useAppearancePreferences();
  const content = useMemo(() => {
    const document = nativeMarkdownWithHtml(
      parseMarkdownWithOptions(props.markdown, { gfm: true, html: true, math: false }),
      (markdown) => parseMarkdownWithOptions(markdown, { gfm: true, html: false, math: false }),
    );
    const content = pullRequestDescriptionContent(document, splitPullRequestBody(props.markdown));
    return {
      ...content,
      attachments: content.attachments.filter((attachment) => !isBotBadgeImage(attachment.uri)),
    };
  }, [props.markdown]);
  const gallery = useMemo<FilePreviewItem[]>(
    () =>
      content.attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => {
          return {
            ...pullRequestImageSource(attachment.uri, mediaContext),
            name: new URL(attachment.uri).pathname.split("/").pop() || "Image",
          };
        }),
    [content, mediaContext],
  );
  const canCollapse = bodyHeight > COLLAPSED_HEIGHT;
  const collapsed = canCollapse && !expanded;
  return (
    <View className="gap-5">
      <View className="gap-3">
        <PullRequestSectionHeading>Description</PullRequestSectionHeading>
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
          <PullRequestSectionHeading>Attachments</PullRequestSectionHeading>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            scrollsToTop={false}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12 }}
          >
            {content.attachments.map((attachment) =>
              attachment.kind !== "image" ? (
                <PullRequestMedia
                  key={attachment.uri}
                  url={attachment.uri}
                  kind={attachment.kind}
                  caption={attachment.caption}
                  compact
                />
              ) : (
                <PullRequestImageAttachment
                  key={attachment.uri}
                  url={attachment.uri}
                  caption={attachment.caption}
                  source={
                    gallery[
                      content.attachments
                        .filter((item) => item.kind === "image")
                        .indexOf(attachment)
                    ]!
                  }
                  gallery={gallery}
                />
              ),
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
