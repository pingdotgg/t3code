import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { modelPreviewCopy } from "@t3tools/client-runtime/file-preview";
import { isMeshFormat, type ModelPreviewFormat } from "@t3tools/shared/filePreview";
import { useMemo, useState } from "react";
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

function readUnavailableMessage(data: string): string | null {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "unavailable" &&
      "reason" in message &&
      typeof message.reason === "string"
      ? message.reason
      : null;
  } catch {
    return null;
  }
}

/** Touch view of a mesh, drawn by the web client's 3D viewer inside a WebView. */
function ModelWebView(props: {
  readonly downloadUrl: string | null;
  readonly name: string;
  readonly onUnavailable: (reason: string) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const [loaded, setLoaded] = useState(false);
  const uri =
    props.downloadUrl === null
      ? null
      : modelViewerPageUrl(props.downloadUrl, props.name, themeAppearance);
  return (
    <View className="flex-1 bg-card">
      {uri === null ? null : (
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
            const reason = readUnavailableMessage(event.nativeEvent.data);
            if (reason !== null) props.onUnavailable(reason);
          }}
          // Servers from before the 3D view have no viewer page.
          onHttpError={() => props.onUnavailable("This server cannot show 3D views yet.")}
          onError={() => props.onUnavailable("The 3D view could not be loaded.")}
          onRenderProcessGone={() => props.onUnavailable("The 3D view stopped unexpectedly.")}
          onContentProcessDidTerminate={() =>
            props.onUnavailable("The 3D view stopped unexpectedly.")
          }
        />
      )}
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
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
