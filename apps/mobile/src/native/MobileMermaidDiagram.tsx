import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText } from "../components/ui/AppText";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";

function buildHtml(source: string, dark: boolean): string {
  // Source travels as JSON inside script, never as raw HTML.
  const payload = JSON.stringify({ source, dark });
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
html,body{margin:0;padding:8px;background:${dark ? "#1f1f1f" : "#ffffff"};}
svg{max-width:100%;height:auto;}
.error{font-family:monospace;font-size:12px;color:${dark ? "#ff9d9d" : "#b3261e"};white-space:pre-wrap;}
</style>
</head>
<body>
<div id="root"></div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
(function(){
var data = ${payload};
var root = document.getElementById("root");
function post(message){ window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
function reportHeight(){ post({ type: "height", height: document.body.scrollHeight }); }
try {
  mermaid.initialize({ startOnLoad: false, theme: data.dark ? "dark" : "default", securityLevel: "strict" });
  mermaid.render("diagram", data.source).then(function(result) {
    root.innerHTML = result.svg;
    reportHeight();
  }).catch(function(error) {
    root.innerHTML = "";
    var div = document.createElement("div");
    div.className = "error";
    div.textContent = String((error && error.message) || error);
    root.appendChild(div);
    post({ type: "error", message: div.textContent });
  });
} catch (error) {
  post({ type: "error", message: String((error && error.message) || error) });
}
new ResizeObserver(reportHeight).observe(document.body);
})();
</script>
</body>
</html>`;
}

type HeightMessage = { readonly type: "height"; readonly height: number };
type ErrorMessage = { readonly type: "error"; readonly message: string };

function parseMermaidMessage(data: string): HeightMessage | ErrorMessage | null {
  try {
    return JSON.parse(data) as HeightMessage | ErrorMessage;
  } catch {
    return null;
  }
}

function isHeightMessage(message: HeightMessage | ErrorMessage): message is HeightMessage {
  return message.type === "height";
}

export function MobileMermaidDiagram(props: { readonly source: string; readonly dark: boolean }) {
  const [height, setHeight] = useState(220);
  const [failed, setFailed] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const html = useMemo(() => buildHtml(props.source, props.dark), [props.source, props.dark]);

  const onMessage = (event: WebViewMessageEvent) => {
    const message = parseMermaidMessage(event.nativeEvent.data);
    if (!message) return;
    if (isHeightMessage(message)) {
      if (Number.isFinite(message.height)) {
        setHeight(Math.min(Math.max(Math.ceil(message.height) + 16, 120), 800));
      }
      return;
    }
    setFailed(message.message);
  };

  return (
    <View className="mb-3 overflow-hidden rounded-lg border border-divider bg-card">
      <View className="flex-row items-center justify-between px-3 py-2">
        <AppText className="text-xs text-muted">Mermaid</AppText>
        <View className="flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showCode ? "Show diagram" : "Show code"}
            onPress={() => setShowCode((value) => !value)}
          >
            <AppText className="text-xs text-link">
              {showCode ? "Show diagram" : "Show code"}
            </AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy diagram source"
            onPress={() => void copyTextWithHaptic(props.source)}
          >
            <AppText className="text-xs text-link">Copy</AppText>
          </Pressable>
        </View>
      </View>
      {showCode ? (
        <View className="px-3 pb-3">
          <AppText selectable className="font-mono text-xs text-code">
            {props.source}
          </AppText>
        </View>
      ) : (
        <WebView
          originWhitelist={["*"]}
          source={{ html }}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          scrollEnabled={false}
          style={{ height }}
          onMessage={onMessage}
        />
      )}
      {failed && !showCode ? (
        <View className="px-3 pb-3">
          <AppText className="text-xs text-muted">Diagram failed to render. See code.</AppText>
        </View>
      ) : null}
    </View>
  );
}
