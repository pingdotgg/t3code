import { useEnvironmentQuery } from "../../state/query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { EnvironmentId, ExtensionInfo } from "@t3tools/contracts";
import {
  extensionPanelDocument,
  extensionPanelRequest,
  extensionPanelResponse,
} from "@t3tools/client-runtime/extension-panel";
import { extensionCommandValue } from "@t3tools/client-runtime/state/extensions";
import { extensionEnvironment, extensionClientSurface } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";

type PanelProps = {
  environmentId: EnvironmentId;
  entry: ExtensionInfo;
  html: string;
  title: string;
};

export function ExtensionPanel(props: PanelProps) {
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

function PanelDocument({ environmentId, entry, html, title }: PanelProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel] = useState(() => Math.random().toString(36));
  const theme = useHtmlRenderTheme();
  const [document] = useState(() =>
    extensionPanelDocument(
      html,
      { surface: extensionClientSurface },
      channel,
      theme,
      entry.settings,
    ),
  );
  const invoke = useAtomCommand(extensionEnvironment.invoke);
  const settings = useAtomCommand(extensionEnvironment.settings);

  const receive = useEffectEvent(async (event: MessageEvent<unknown>) => {
    if (event.source !== frame.current?.contentWindow) return;
    const request = extensionPanelRequest(event.data, channel);
    if (!request) return;
    const response = await extensionPanelResponse(request, {
      command: (name, input) =>
        invoke({
          environmentId,
          input: {
            id: entry.manifest.id,
            kind: "command",
            name,
            input,
            context: { surface: extensionClientSurface },
          },
        }).then(extensionCommandValue),
      settings: (patch) =>
        settings({ environmentId, input: { id: entry.manifest.id, settings: patch } }).then(
          (result) =>
            extensionCommandValue(result).find((item) => item.manifest.id === entry.manifest.id)
              ?.settings,
        ),
    });
    if (event.source === frame.current?.contentWindow)
      frame.current.contentWindow?.postMessage(
        { type: "t3-extension-response", channel, requestId: request.requestId, ...response },
        "*",
      );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to messages from this extension's browser frame.
  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      void receive(event);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Sends live client theme and committed settings to the existing frame without reloading it.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: "t3-extension-state", channel, theme, settings: entry.settings },
      "*",
    );
  }, [theme, entry.settings, channel]);
  return (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- Extensions are explicitly trusted UI with unrestricted access.
    <iframe
      ref={frame}
      title={title}
      srcDoc={document}
      onLoad={() =>
        frame.current?.contentWindow?.postMessage(
          { type: "t3-extension-state", channel, theme, settings: entry.settings },
          "*",
        )
      }
      className="h-[32rem] w-full rounded border"
    />
  );
}
