import { useEnvironmentQuery } from "../../state/query";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { WebView } from "react-native-webview";
import type { EnvironmentId, ExtensionInfo } from "@t3tools/contracts";
import {
  extensionPanelDocument,
  extensionPanelRequest,
  extensionPanelResponse,
} from "@t3tools/client-runtime/extension-panel";
import { extensionCommandValue } from "@t3tools/client-runtime/state/extensions";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";

type PanelProps = {
  environmentId: EnvironmentId;
  entry: ExtensionInfo;
  html: string;
};

export function MobileExtensionPanel(props: PanelProps) {
  const query = useEnvironmentQuery(
    extensionEnvironment.state({ environmentId: props.environmentId, input: {} }),
  );
  const current =
    query.error === null
      ? query.data?.find(
          (entry) =>
            entry.manifest.id === props.entry.manifest.id &&
            entry.enabled &&
            entry.status === "running" &&
            entry.runtimeId !== undefined &&
            entry.runtimeId === props.entry.runtimeId,
        )
      : undefined;
  return current ? <PanelDocument {...props} entry={current} /> : null;
}

function PanelDocument({ environmentId, entry, html }: PanelProps) {
  const view = useRef<WebView<object>>(null);
  const [channel] = useState(() => `${entry.manifest.id}-${Math.random()}`);
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  const theme = mobileHtmlRenderTheme({
    themeId,
    appearance: themeAppearance,
    variables: themeVariables,
    systemColors: systemColorsActive,
    platform: Platform.OS,
  });
  const [source] = useState(() => ({
    html: extensionPanelDocument(html, { surface: "mobile" }, channel, theme, entry.settings),
  }));
  const invoke = useAtomCommand(extensionEnvironment.invoke);
  const settings = useAtomCommand(extensionEnvironment.settings);
  const post = (message: unknown) =>
    view.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(message).replaceAll("<", "\\u003c")}}));true;`,
    );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Sends committed settings and native theme changes into the existing WebView.
  useEffect(() => {
    view.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify({ type: "t3-extension-state", channel, theme, settings: entry.settings }).replaceAll("<", "\\u003c")}}));true;`,
    );
  }, [theme, entry.settings, channel]);
  return (
    <View className="h-96">
      <WebView<object>
        ref={view}
        originWhitelist={["*"]}
        source={source}
        onLoad={() =>
          post({ type: "t3-extension-state", channel, theme, settings: entry.settings })
        }
        onMessage={(event) => {
          let value: unknown;
          try {
            value = JSON.parse(event.nativeEvent.data);
          } catch {
            return;
          }
          const request = extensionPanelRequest(value, channel);
          if (!request) return;
          void extensionPanelResponse(request, {
            command: (name, input) =>
              invoke({
                environmentId,
                input: {
                  id: entry.manifest.id,
                  kind: "command",
                  name,
                  input,
                  context: { surface: "mobile" },
                },
              }).then(extensionCommandValue),
            settings: (patch) =>
              settings({ environmentId, input: { id: entry.manifest.id, settings: patch } }).then(
                (result) =>
                  extensionCommandValue(result).find(
                    (item) => item.manifest.id === entry.manifest.id,
                  )?.settings,
              ),
          }).then((response) =>
            post({
              type: "t3-extension-response",
              channel,
              requestId: request.requestId,
              ...response,
            }),
          );
        }}
      />
    </View>
  );
}
