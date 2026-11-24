import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";
import {
  PullRequestImageAttachment,
  PullRequestMedia,
  PullRequestMediaContext,
} from "./PullRequestMedia";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import { T, useGT, useMessages } from "gt-react-native";
import { useContext, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  pullRequestImageSource,
  pullRequestScopedSourceIdentifier,
} from "./pullRequestMediaSource";
import { filePreviewKey, imagePreviewName } from "../../lib/filePreviewGallery";
import { markdownReferenceDefinitions, parseMarkdownDocument } from "../../lib/markdownDocument";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal";
import { isBotBadgeImage } from "./botBadgeImages";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";

const COLLAPSED_HEIGHT = 240;

export function PullRequestDescription(props: {
  readonly markdown: string;
  /** Clips a long description behind "Show more"; absent, it is always shown in full. */
  readonly collapse?: {
    readonly expanded: boolean;
    readonly onExpandedChange: (expanded: boolean) => void;
    readonly onCollapse: () => void;
  };
  readonly footer?: ReactNode;
  readonly onTaskListChange?: ComponentProps<typeof PullRequestMarkdown>["onTaskListChange"];
}) {
  const { collapse } = props;
  const expanded = collapse?.expanded ?? true;
  const gt = useGT();
  const imageFallback = gt("Image");
  const messages = useMessages();
  const stripScope = `pr-attachment:${useId()}`;
  const [bodyHeight, setBodyHeight] = useState(0);
  const mediaContext = useContext(PullRequestMediaContext);
  const { themeVariables: colors } = useAppearancePreferences();
  const fadeColor = colors[Platform.OS === "android" ? "--color-sheet-solid" : "--color-screen"];
  const content = useMemo(() => {
    const document = parseMarkdownDocument(props.markdown);
    const content = pullRequestDescriptionContent(
      document,
      splitPullRequestBody(props.markdown, markdownReferenceDefinitions),
      messages,
    );
    return {
      ...content,
      attachments: content.attachments.filter((attachment) => !isBotBadgeImage(attachment.uri)),
    };
  }, [props.markdown, messages]);
  const { gallery, galleryByUri } = useMemo(() => {
    const byUri = new Map<string, FilePreviewItem>();
    const byKey = new Map<string, FilePreviewItem>();
    const items: FilePreviewItem[] = [];
    for (const attachment of content.attachments) {
      if (attachment.kind !== "image") continue;
      const name = imagePreviewName(attachment.uri, attachment.caption, imageFallback);
      const source = pullRequestImageSource(attachment.uri, mediaContext, name);
      const key = filePreviewKey(source);
      const existing = byKey.get(key);
      if (existing) {
        byUri.set(attachment.uri, existing);
        continue;
      }
      const item: FilePreviewItem = {
        ...source,
        sourceIdentifier: pullRequestScopedSourceIdentifier(stripScope, source),
      };
      items.push(item);
      byKey.set(key, item);
      byUri.set(attachment.uri, item);
    }
    return { gallery: items, galleryByUri: byUri };
  }, [content.attachments, mediaContext, imageFallback, stripScope]);
  const canCollapse = collapse !== undefined && bodyHeight > COLLAPSED_HEIGHT;
  const collapsed = canCollapse && !expanded;
  return (
    <View className="gap-5">
      <View className="gap-3">
        <PullRequestSectionHeading>
          <T>Description</T>
        </PullRequestSectionHeading>
        {props.markdown.trim() ? (
          <View className="overflow-hidden">
            <View
              style={{
                height: expanded ? bodyHeight : Math.min(bodyHeight, COLLAPSED_HEIGHT),
                overflow: "hidden",
              }}
            >
              <View
                style={{ position: "absolute", top: 0, left: 0, right: 0 }}
                onLayout={(event) => setBodyHeight(event.nativeEvent.layout.height)}
              >
                <PullRequestMarkdown
                  markdown={props.markdown}
                  onTaskListChange={props.onTaskListChange}
                />
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
                      <Stop offset="0" stopColor={fadeColor} stopOpacity={0} />
                      <Stop offset="0.5" stopColor={fadeColor} stopOpacity={0.94} />
                      <Stop offset="0.72" stopColor={fadeColor} stopOpacity={1} />
                      <Stop offset="1" stopColor={fadeColor} stopOpacity={1} />
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
                    backgroundColor: fadeColor,
                  }}
                />
              </View>
            ) : null}
            {collapse !== undefined && canCollapse ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={
                  expanded ? gt("Collapse description") : gt("Expand description")
                }
                onPress={() => {
                  if (expanded) collapse.onCollapse();
                  collapse.onExpandedChange(!expanded);
                }}
                style={
                  collapsed
                    ? { position: "absolute", bottom: 2, left: 0, right: 0, height: 44, zIndex: 2 }
                    : undefined
                }
                className="min-h-11 flex-row items-center justify-center gap-1 py-2 active:opacity-70"
              >
                <Text className="text-xs font-t3-medium text-foreground">
                  {expanded ? gt("Show less") : gt("Show more")}
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
          <Text className="text-sm text-foreground-muted">
            <T>No description provided.</T>
          </Text>
        )}
        {props.footer}
      </View>
      {content.attachments.length ? (
        <View className="gap-3">
          <PullRequestSectionHeading>
            <T>Attachments</T>
          </PullRequestSectionHeading>
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
                  source={galleryByUri.get(attachment.uri)!}
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
