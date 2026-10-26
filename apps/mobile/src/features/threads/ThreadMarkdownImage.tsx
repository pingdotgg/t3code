import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { createContext, useContext, useEffect, useEffectEvent, useId, useState } from "react";
import { fetch } from "expo/fetch";
import { parse, SvgAst, type JsxAST } from "react-native-svg";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useFilePreviewGallery } from "../../components/FilePreviewGallery";
import { AppText as Text } from "../../components/ui/AppText";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { MediaActionsMenu } from "../../components/MediaActionsMenu";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { useMediaActions } from "../../state/mediaActions";
import type { MediaActionsSource } from "../../lib/mediaActionsSource";
import { useAssetUrlState } from "../../state/assets";
import {
  MARKDOWN_IMAGE_MAX_WIDTH,
  type MarkdownImageDisplaySize,
  resolveMarkdownImageDisplaySize,
  resolveSvgImageSize,
} from "./markdownImageSize";

/** Use known feed width immediately; later image measurement would move already-positioned rows. */
export const MarkdownImageAvailableWidthContext = createContext(0);

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly unavailable: boolean;
  readonly unavailableDetail?: string | undefined;
  readonly alt: string | null;
  readonly knownSize?: { readonly width: number; readonly height: number } | undefined;
  readonly format?: "svg";
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const withGallery = useFilePreviewGallery();
  const sourceIdentifier = useId();
  const mediaActions = useMediaActions(props.actionsSource);
  const contextWidth = useContext(MarkdownImageAvailableWidthContext);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const availableWidth =
    measuredWidth > 0 && contextWidth > 0
      ? Math.min(contextWidth, measuredWidth)
      : contextWidth || measuredWidth;
  // Keyed by source so a new source drops the previous image's decoded dimensions.
  const [decoded, setDecoded] = useState<{
    sourceKey: string;
    size: { width: number; height: number };
  } | null>(null);
  const decodedSize = decoded?.sourceKey === props.sourceKey ? decoded.size : null;
  // A failure belongs to one URI; any URI change, including through null, retries.
  const [failure, setFailure] = useState({ uri: props.uri, failed: false });
  if (failure.uri !== props.uri) setFailure({ uri: props.uri, failed: false });

  const sourceSize = decodedSize ?? props.knownSize ?? null;
  const displaySize: MarkdownImageDisplaySize | null =
    sourceSize === null || availableWidth <= 0
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });
  const failed =
    props.unavailable || (props.uri !== null && failure.uri === props.uri && failure.failed);
  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";
  const frameStyle: ViewStyle = displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 };

  return (
    <View
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6 }}
    >
      {props.uri === null || failed ? (
        <MediaActionsMenu media={mediaActions}>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={props.alt ?? "Markdown image"}
            accessibilityHint={
              mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
            }
            className="items-center justify-center rounded-[10px] bg-md-code-bg"
            style={frameStyle}
          >
            {failed ? (
              <Text className="px-3 text-center text-xs text-foreground-muted">
                {props.unavailableDetail
                  ? `Image unavailable. ${props.unavailableDetail}`
                  : "Image unavailable"}
              </Text>
            ) : (
              <AppActivityIndicator />
            )}
          </Pressable>
        </MediaActionsMenu>
      ) : (
        <PresentationSource identifier={sourceIdentifier} style={{ alignSelf: "flex-start" }}>
          <MediaActionsMenu media={mediaActions}>
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={props.alt ?? "Markdown image"}
              accessibilityHint={
                mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
              }
              onPress={() =>
                props.onPressPreview(
                  withGallery({
                    kind: "image",
                    uri: props.uri!,
                    name: props.actionsSource?.name ?? props.alt ?? "Image",
                    sourceIdentifier,
                    actionsSource: props.actionsSource,
                  }),
                )
              }
              style={{ alignSelf: "flex-start" }}
            >
              <View
                className="items-center justify-center overflow-hidden rounded-[10px] bg-md-code-bg"
                style={frameStyle}
              >
                <ThreadMarkdownImageRequest
                  key={props.sourceKey}
                  uri={props.uri}
                  format={props.format}
                  onLoad={(size) => setDecoded({ sourceKey: props.sourceKey, size })}
                  onError={() => setFailure({ uri: props.uri, failed: true })}
                />
              </View>
            </Pressable>
          </MediaActionsMenu>
        </PresentationSource>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadMarkdownImageRequest(props: {
  readonly uri: string;
  readonly onLoad: (sourceSize: { width: number; height: number }) => void;
  readonly onError: () => void;
  readonly format?: "svg";
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      {props.format === "svg" ? (
        <ThreadMarkdownSvg
          uri={props.uri}
          onLoad={(size) => {
            setLoaded(true);
            if (size) props.onLoad(size);
          }}
          onError={props.onError}
        />
      ) : (
        <Image
          source={{ uri: props.uri }}
          contentFit="contain"
          cachePolicy="memory-disk"
          accessible={false}
          onLoad={(event) => {
            setLoaded(true);
            props.onLoad(event.source);
          }}
          onError={props.onError}
          style={{ width: "100%", height: "100%", opacity: loaded ? 1 : 0 }}
        />
      )}
      {loaded ? null : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
        >
          <Text className="text-xs text-foreground-muted">Loading image…</Text>
        </View>
      )}
    </>
  );
}

function ThreadMarkdownSvg(props: {
  readonly uri: string;
  readonly onLoad: (size: { width: number; height: number } | null) => void;
  readonly onError: () => void;
}) {
  const [ast, setAst] = useState<JsxAST | null>(null);
  const onLoad = useEffectEvent(props.onLoad);
  const onError = useEffectEvent(props.onError);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (props.uri.startsWith("data:image/svg+xml")) {
        const comma = props.uri.indexOf(",");
        if (comma < 0) throw new Error("SVG data URI has no content");
        const content = decodeURIComponent(props.uri.slice(comma + 1));
        return props.uri.slice(0, comma).includes(";base64")
          ? new TextDecoder().decode(
              Uint8Array.from(atob(content), (character) => character.charCodeAt(0)),
            )
          : content;
      }
      const response = await fetch(props.uri, { signal: controller.signal });
      if (!response.ok && !(response.status === 0 && props.uri.startsWith("file://")))
        throw new Error(`SVG request failed: ${response.status}`);
      return response.text();
    };
    void load()
      .then((xml) => {
        const parsed = parse(xml);
        if (!parsed) throw new Error("SVG has no root element");
        if (controller.signal.aborted) return;
        setAst(parsed);
        onLoad(resolveSvgImageSize(parsed.props));
      })
      .catch(() => {
        if (!controller.signal.aborted) onError();
      });
    return () => controller.abort();
  }, [props.uri]);
  return <SvgAst ast={ast} override={{ width: "100%", height: "100%", accessible: false }} />;
}

export function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    { readonly _tag: "attachment" | "media-file" | "draft-workspace-file" | "tool-output-image" }
  >;
  readonly alt: string | null;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const withGallery = useFilePreviewGallery();
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === "Success" ? assetUrl.url + (props.srcFragment ?? "") : null}
      sourceKey={
        props.resource._tag === "attachment"
          ? `attachment:${props.resource.attachmentId}`
          : props.resource._tag === "tool-output-image"
            ? `tool-output:${props.resource.itemId}:${props.resource.index}`
            : `workspace:${props.resource.path}`
      }
      unavailable={assetUrl._tag === "Failure"}
      unavailableDetail={
        assetUrl._tag === "Failure" && assetUrl.reason === "missing-file-access"
          ? MISSING_FILE_ACCESS_MESSAGE
          : undefined
      }
      knownSize={assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined}
      format={
        (props.resource._tag === "media-file" || props.resource._tag === "draft-workspace-file") &&
        /\.svg$/i.test(props.resource.path)
          ? "svg"
          : undefined
      }
      alt={props.alt}
      actionsSource={props.actionsSource}
      onPressPreview={(source) => {
        const { uri: _uri, ...rest } = source as FilePreviewSource & { uri?: string };
        props.onPressPreview(
          withGallery({
            ...rest,
            gallery: undefined,
            environmentId: props.environmentId,
            resource: props.resource,
          }),
        );
      }}
    />
  );
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView
      uri={null}
      sourceKey="unavailable"
      unavailable
      alt={props.alt}
      onPressPreview={() => undefined}
    />
  );
}
