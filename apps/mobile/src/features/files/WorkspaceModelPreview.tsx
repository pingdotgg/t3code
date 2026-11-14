import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { modelPreviewCopy } from "@t3tools/client-runtime/file-preview";
import { isMeshFormat, type ModelPreviewFormat } from "@t3tools/shared/filePreview";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { useAssetUrlState } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { FilePreviewNotice } from "./FilePreviewFeedback";
import { resolveWorkspaceFilePath } from "./filePath";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";

/** The web client page that shows one 3D file from a signed download URL. */
const MODEL_VIEWER_PAGE_PATH = "/model-viewer";

/** The viewer page's URL on the same server as the signed download URL. */
function modelViewerPageUrl(downloadUrl: string, name: string, appearance: string) {
  const page = new URL(MODEL_VIEWER_PAGE_PATH, downloadUrl);
  page.hash = new URLSearchParams({ src: downloadUrl, name, appearance }).toString();
  return page.href;
}

/** How long after the page loads the viewer has to say it is running. */
const VIEWER_READY_TIMEOUT_MS = 10_000;

const NO_VIEWER_PAGE = "This server cannot show 3D views yet.";

type ViewerMessage =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly reason: string };

function readViewerMessage(data: string): ViewerMessage | null {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null || !("type" in message)) return null;
    if (message.type === "ready") return { type: "ready" };
    return message.type === "unavailable" &&
      "reason" in message &&
      typeof message.reason === "string"
      ? { type: "unavailable", reason: message.reason }
      : null;
  } catch {
    return null;
  }
}

/**
 * Touch view of a mesh, drawn by the web client's 3D viewer inside a WebView. Mount it with a
 * `key` per URL, so each page load starts its own ready handshake.
 */
function ModelWebView(props: {
  readonly downloadUrl: string | null;
  readonly name: string;
  readonly onUnavailable: (reason: string) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const { onUnavailable } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times out a viewer that never reports in
  useEffect(() => {
    if (!loaded || ready) return;
    // Older servers answer this path with their own app, which never reports in.
    const timer = setTimeout(() => onUnavailable(NO_VIEWER_PAGE), VIEWER_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loaded, ready, onUnavailable]);
  const uri =
    props.downloadUrl === null
      ? null
      : modelViewerPageUrl(props.downloadUrl, props.name, themeAppearance);
  return (
    <View className="flex-1 bg-card">
      {uri === null ? null : (
        // Until the viewer reports in, the page may be an older server's app: keep it untouchable.
        <View className="flex-1" pointerEvents={ready ? "auto" : "none"}>
          <WebView<object>
            source={{ uri }}
            accessibilityLabel={`3D view of ${props.name}`}
            style={{ flex: 1, backgroundColor: "transparent" }}
            // The page handles every gesture itself; nothing should scroll or zoom the WebView.
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
            setBuiltInZoomControls={false}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(request) =>
              request.url.split("#", 1)[0] === uri.split("#", 1)[0]
            }
            onLoadEnd={() => setLoaded(true)}
            onMessage={(event: WebViewMessageEvent) => {
              const message = readViewerMessage(event.nativeEvent.data);
              if (message?.type === "ready") setReady(true);
              else if (message?.type === "unavailable") props.onUnavailable(message.reason);
            }}
            // Servers from before the 3D view have no viewer page.
            onHttpError={() => props.onUnavailable(NO_VIEWER_PAGE)}
            onError={() => props.onUnavailable("The 3D view could not be loaded.")}
            onRenderProcessGone={() => props.onUnavailable("The 3D view stopped unexpectedly.")}
            onContentProcessDidTerminate={() =>
              props.onUnavailable("The 3D view stopped unexpectedly.")
            }
          />
        </View>
      )}
      {ready ? null : (
        // Opaque, so an older server's app page never shows before the picture fallback.
        <View className="absolute inset-0 items-center justify-center bg-card">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

function ModeBar(props: {
  readonly hint: string;
  readonly action: string;
  readonly onPress: () => void;
}) {
  return (
    <View className="flex-row items-center gap-3 border-b border-border bg-card px-4 py-2">
      <Text className="flex-1 text-xs leading-snug text-foreground-muted">{props.hint}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={props.onPress}
        className="rounded-full bg-subtle px-3 py-1.5 active:bg-subtle-strong"
      >
        <Text className="text-xs font-t3-bold text-foreground">{props.action}</Text>
      </Pressable>
    </View>
  );
}

/**
 * A workspace 3D file opens in a touch 3D view, with the server's picture one tap away. `.blend`
 * files load the geometry the server's Blender exports; without it, or for anything the 3D view
 * cannot draw, the picture shows instead.
 */
export function WorkspaceModelPreview(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly cwd: string | null;
  readonly relativePath: string;
  readonly format: ModelPreviewFormat;
  readonly name: string;
  readonly previewUri: string | null;
}) {
  const copy = modelPreviewCopy(props.format);
  const { environmentId, threadId, cwd, relativePath } = props;
  // The 3D view downloads the raw mesh, or a `.blend` file's exported geometry; the picture is the
  // inline preview URL.
  const disposition = isMeshFormat(props.format) ? "attachment" : "geometry";
  const download = useMemo<AssetResource | null>(() => {
    if (cwd === null) return null;
    return threadId !== null
      ? {
          _tag: "media-file",
          threadId,
          path: resolveWorkspaceFilePath(cwd, relativePath),
          disposition,
        }
      : { _tag: "draft-workspace-file", cwd, path: relativePath, disposition };
  }, [cwd, disposition, relativePath, threadId]);
  const canShow3d = environmentId !== null && download !== null;
  const downloadUrl = useAssetUrlState(environmentId, canShow3d ? download : null);
  const [mode, setMode] = useState<"3d" | "picture">("3d");
  const [reported, setReported] = useState<string | null>(null);
  const problem = reported ?? (downloadUrl._tag === "Failure" ? copy.viewerMissing : null);

  if (canShow3d && mode === "3d" && problem === null) {
    return (
      <View className="flex-1 bg-card">
        <ModeBar
          hint="Drag to orbit · pinch to zoom · two fingers pan · double-tap resets"
          action={props.format === "blend" ? "Thumbnail" : "Picture"}
          onPress={() => setMode("picture")}
        />
        <ModelWebView
          key={downloadUrl._tag === "Success" ? downloadUrl.url : "pending"}
          downloadUrl={downloadUrl._tag === "Success" ? downloadUrl.url : null}
          name={props.name}
          onUnavailable={setReported}
        />
      </View>
    );
  }
  return (
    <View className="flex-1 bg-card">
      {canShow3d && problem === null ? (
        <ModeBar hint={copy.notice} action="3D view" onPress={() => setMode("3d")} />
      ) : (
        <FilePreviewNotice>{problem ?? copy.notice}</FilePreviewNotice>
      )}
      <WorkspaceFileImagePreview
        accessibilityLabel={props.name}
        uri={props.previewUri}
        unavailableTitle="No preview for this file"
        unavailableDetail={copy.unavailable}
      />
    </View>
  );
}
