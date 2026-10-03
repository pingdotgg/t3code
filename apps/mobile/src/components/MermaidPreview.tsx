import { canPreviewMermaid, renderMermaidPreview } from "@t3tools/client-runtime/mermaid-preview";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { useMobileThemeAppearance } from "../lib/useUniwindTheme";

export function MermaidPreview({ source, children }: { source: string; children: ReactNode }) {
  const theme = useMobileThemeAppearance();
  const [requestedSource, setRequestedSource] = useState<string | null>(null);
  const open = requestedSource === source;
  const [image, setImage] = useState<{ key: string; html: string; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${theme}:${source}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void renderMermaidPreview(source, theme, controller.signal).then(
      ({ svg, height }) => {
        if (controller.signal.aborted) return;
        const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        setImage({
          key,
          height: Math.min(360, height),
          html: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"></head><body style="margin:0"><img alt="Mermaid diagram" src="${uri}"></body></html>`,
        });
      },
      () => {
        if (!controller.signal.aborted) setError(key);
      },
    );
    return () => controller.abort();
  }, [key, open, source, theme]);
  return (
    <View>
      {canPreviewMermaid(source) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? "Hide diagram" : "Preview diagram"}
          onPress={() => {
            setImage(null);
            setError(null);
            setRequestedSource(open ? null : source);
          }}
          className="px-3 py-2"
        >
          <Text className="text-sm text-foreground">
            {open ? "Hide diagram" : "Preview diagram"}
          </Text>
        </Pressable>
      ) : null}
      {open ? (
        image?.key === key ? (
          <WebView
            source={{ html: image.html }}
            style={{ flex: 0, height: image.height, backgroundColor: "transparent" }}
            javaScriptEnabled={false}
            scrollEnabled
            nestedScrollEnabled
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            setSupportMultipleWindows={false}
            // Static HTML needs an unrestricted origin whitelist; the request
            // callback denies every navigation except the initial blank page.
            originWhitelist={["*"]}
            onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
          />
        ) : (
          <Text className="px-3 text-xs text-foreground-muted">
            {error === key
              ? "Could not preview this diagram. Source is shown below."
              : "Preparing diagram..."}
          </Text>
        )
      ) : null}
      {children}
    </View>
  );
}

export function renderMermaidCodeBlock(
  source: string,
  language: string | undefined,
  children: ReactNode,
) {
  return language?.trim().toLowerCase() === "mermaid" ? (
    <MermaidPreview source={source}>{children}</MermaidPreview>
  ) : (
    children
  );
}
