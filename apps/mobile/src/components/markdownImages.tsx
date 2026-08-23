import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, StyleSheet, View, type ViewStyle } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";

import { useThemeColor } from "../lib/useThemeColor";
import { useAssetUrlState } from "../state/assets";
import {
  MARKDOWN_IMAGE_MAX_WIDTH,
  resolveMarkdownImageDisplaySize,
} from "../features/threads/markdownImageSize";
import { AppText as Text } from "./AppText";

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly unavailable: boolean;
  readonly alt: string | null;
  readonly onPressImage?: ((uri: string) => void) | undefined;
}) {
  const codeBackground = useThemeColor("--color-md-code-bg");
  const [availableWidth, setAvailableWidth] = useState(0);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const activeUriRef = useRef(props.uri);
  activeUriRef.current = props.uri;

  useEffect(() => {
    setSourceSize(null);
  }, [props.sourceKey]);

  useEffect(() => {
    setFailedUri(null);
  }, [props.uri]);

  const displaySize =
    sourceSize === null
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });
  const failed = props.unavailable || (props.uri !== null && failedUri === props.uri);
  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";
  const frameStyle: ViewStyle = displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 };

  const image =
    props.uri === null || failed ? (
      <View
        style={{
          ...frameStyle,
          borderRadius: 10,
          backgroundColor: codeBackground,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {failed ? (
          <Text className="text-xs text-foreground-muted">Image unavailable</Text>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    ) : (
      <View
        style={{
          ...frameStyle,
          borderRadius: 10,
          backgroundColor: codeBackground,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Image
          source={{ uri: props.uri }}
          resizeMode="contain"
          accessible={false}
          onLoad={(event) => {
            if (activeUriRef.current !== props.uri) return;
            const { width, height } = event.nativeEvent.source;
            setSourceSize({ width, height });
          }}
          onError={() => setFailedUri(props.uri)}
          style={{
            width: "100%",
            height: "100%",
            opacity: displaySize === null ? 0 : 1,
          }}
        />
        {displaySize === null ? <ActivityIndicator style={StyleSheet.absoluteFill} /> : null}
      </View>
    );

  return (
    <View
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6 }}
    >
      {props.uri !== null && !failed && props.onPressImage ? (
        <TouchableOpacity
          accessibilityRole="imagebutton"
          accessibilityLabel={props.alt ?? "Markdown image"}
          activeOpacity={0.7}
          onPress={() => props.onPressImage?.(props.uri!)}
          style={{ alignSelf: "flex-start" }}
        >
          {image}
        </TouchableOpacity>
      ) : (
        image
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView uri={null} sourceKey="unavailable" unavailable alt={props.alt} />
  );
}

/** Markdown image whose src is a workspace file. It loads through a signed asset URL. */
export function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly alt: string | null;
  readonly onPressImage?: ((uri: string) => void) | undefined;
}) {
  const isSvg = /\.svg$/i.test(props.path);
  const assetUrl = useAssetUrlState(
    props.environmentId,
    isSvg
      ? null
      : {
          _tag: "workspace-file",
          threadId: props.threadId,
          path: props.path,
        },
  );

  if (isSvg) {
    return <ThreadMarkdownImageUnavailable alt={props.alt} />;
  }

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === "Success" ? assetUrl.url : null}
      sourceKey={props.path}
      unavailable={assetUrl._tag === "Failure"}
      alt={props.alt}
      onPressImage={props.onPressImage}
    />
  );
}
