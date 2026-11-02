import { useAtomValue } from "@effect/atom-react";
import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { Image } from "expo-image";
import { createContext, useContext, useId, useState } from "react";
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
import { assetImageCacheKey } from "../../lib/assetImageSource";
import {
  MARKDOWN_IMAGE_MAX_WIDTH,
  type MarkdownImageDisplaySize,
  resolveMarkdownImageDisplaySize,
  resolveSvgImageSize,
} from "./markdownImageSize";

/** Use known feed width immediately; later image measurement would move already-positioned rows. */
export const MarkdownImageAvailableWidthContext = createContext(0);

type ImageSize = { readonly width: number; readonly height: number };

class SvgLoadError extends Data.TaggedError("SvgLoadError")<{ readonly cause: unknown }> {}

async function readSvgXml(uri: string, signal: AbortSignal): Promise<string> {
  if (uri.startsWith("data:image/svg+xml")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("SVG data URI has no content");
    const content = decodeURIComponent(uri.slice(comma + 1));
    return uri.slice(0, comma).includes(";base64")
      ? new TextDecoder().decode(
          Uint8Array.from(atob(content), (character) => character.charCodeAt(0)),
        )
      : content;
  }
  // expo/fetch, not the runtime HttpClient: it is the one that reads file:// URIs.
  const response = await fetch(uri, { signal });
  if (!response.ok && !(response.status === 0 && uri.startsWith("file://")))
    throw new Error(`SVG request failed: ${response.status}`);
  return response.text();
}

type SvgDocument = { readonly ast: JsxAST; readonly size: ImageSize | null };

// Feed rows unmount as they scroll away. Only parsed documents outlive their
// readers (for the row that scrolls back); a failed load is dropped with its last
// reader so the next mount fetches again.
const parsedSvgDocumentAtom = Atom.family((_uri: string) =>
  Atom.make<SvgDocument | null>(null).pipe(
    Atom.setIdleTTL(60_000),
    Atom.withLabel("mobile:thread-markdown-svg-parsed"),
  ),
);

const svgDocumentAtom = Atom.family((uri: string) =>
  Atom.make((get) => {
    const parsed = parsedSvgDocumentAtom(uri);
    const cached = get(parsed);
    if (cached !== null) return Effect.succeed(cached);
    return Effect.tryPromise({
      try: async (signal): Promise<SvgDocument> => {
        const ast = parse(await readSvgXml(uri, signal));
        if (!ast) throw new Error("SVG has no root element");
        return { ast, size: resolveSvgImageSize(ast.props) };
      },
      catch: (cause) => new SvgLoadError({ cause }),
    }).pipe(Effect.tap((document) => Effect.sync(() => get.set(parsed, document))));
  }).pipe(Atom.withLabel("mobile:thread-markdown-svg")),
);

const noSvgDocumentAtom = Atom.make(AsyncResult.initial<SvgDocument, SvgLoadError>());

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly cacheKey?: string | undefined;
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
  const svg = useAtomValue(
    props.format === "svg" && props.uri !== null ? svgDocumentAtom(props.uri) : noSvgDocumentAtom,
  );
  const svgDocument = AsyncResult.isSuccess(svg) ? svg.value : null;
  // Keyed by source so a new source drops the previous image's decoded dimensions.
  const [decoded, setDecoded] = useState<{ sourceKey: string; size: ImageSize } | null>(null);
  const decodedSize =
    svgDocument?.size ?? (decoded?.sourceKey === props.sourceKey ? decoded.size : null);
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
    props.unavailable ||
    (props.uri !== null && failure.uri === props.uri && failure.failed) ||
    AsyncResult.isFailure(svg);
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
                {props.format === "svg" ? (
                  <ThreadMarkdownSvg ast={svgDocument?.ast ?? null} />
                ) : (
                  <ThreadMarkdownImageRequest
                    key={props.sourceKey}
                    uri={props.uri}
                    cacheKey={props.cacheKey}
                    onLoad={(size) =>
                      // Only the first decode counts: later loads report the bitmap
                      // downsampled for the current frame (969 vs 970 wide), so keeping
                      // them resizes the frame, which reloads the image, and so on.
                      setDecoded((current) =>
                        current?.sourceKey === props.sourceKey
                          ? current
                          : { sourceKey: props.sourceKey, size },
                      )
                    }
                    onError={() => setFailure({ uri: props.uri, failed: true })}
                  />
                )}
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
  readonly cacheKey: string | undefined;
  readonly onLoad: (sourceSize: ImageSize) => void;
  readonly onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      <Image
        source={{ uri: props.uri, cacheKey: props.cacheKey }}
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
      {loaded ? null : <ThreadMarkdownImageLoading />}
    </>
  );
}

function ThreadMarkdownImageLoading() {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
    >
      <Text className="text-xs text-foreground-muted">Loading image…</Text>
    </View>
  );
}

function ThreadMarkdownSvg(props: { readonly ast: JsxAST | null }) {
  return props.ast === null ? (
    <ThreadMarkdownImageLoading />
  ) : (
    <SvgAst ast={props.ast} override={{ width: "100%", height: "100%", accessible: false }} />
  );
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
  const resourceKey =
    props.resource._tag === "attachment"
      ? `attachment:${props.resource.attachmentId}`
      : props.resource._tag === "tool-output-image"
        ? `tool-output:${props.resource.itemId}:${props.resource.index}`
        : `workspace:${props.resource.path}`;
  // The view keeps the first decoded size per key, so a file edited in place needs a
  // new key; a re-signed URL for the same revision must not get one.
  const sourceKey =
    assetUrl._tag === "Success" && assetUrl.fileRevision !== undefined
      ? `${resourceKey}@${assetUrl.fileRevision}`
      : resourceKey;

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === "Success" ? assetUrl.url + (props.srcFragment ?? "") : null}
      cacheKey={
        assetUrl._tag === "Success"
          ? assetImageCacheKey(props.environmentId, props.resource, assetUrl.fileRevision)
          : undefined
      }
      sourceKey={sourceKey}
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
