import { mediaReferenceFileName } from "@t3tools/client-runtime/media-reference";
import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";
import {
  PullRequestImageAttachment,
  PullRequestMedia,
  PullRequestMediaContext,
} from "./PullRequestMedia";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import { T, useGT, useMessages } from "gt-react-native";
import { useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { pullRequestImageSource } from "./pullRequestMediaSource";
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
  const messages = useMessages();
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
  const gallery: FilePreviewItem[] = content.attachments
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => {
      return {
        ...pullRequestImageSource(attachment.uri, mediaContext),
        name: mediaReferenceFileName({ kind: "url", url: attachment.uri }) || gt("Image"),
      };
    });
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
                    height: Platform.OS === "android" ? 48 : 44,
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
                    ? {
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: Platform.OS === "android" ? 48 : 44,
                        zIndex: 2,
                      }
                    : undefined
                }
                className="min-h-[44px] flex-row items-center justify-center gap-1 py-2 active:opacity-70 android:min-h-[48px]"
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
