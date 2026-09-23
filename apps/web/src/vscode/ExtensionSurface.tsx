import type { ExtensionRuntimeProps } from "~/components/extensions/ExtensionSurfaceFrame";
import { usePreparedConnection } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import {
  activeWebview,
  attachPart,
  getRuntime,
  openViewContainer,
  parkEditor,
  Parts,
  showEditor,
  showWebview,
  syncTheme,
} from "./runtime";
import "./extensionSurface.css";

export function ExtensionSurface(props: ExtensionRuntimeProps) {
  const { environmentId, target, workspaceRoot, onOpenWebview } = props;
  const extensionId = props.extension.id;
  const firstViewContainerId = props.extension.viewContainers[0]?.id;
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const httpBaseUrl = Option.getOrNull(usePreparedConnection(environmentId))?.httpBaseUrl;
  const connect = useAtomCommand(serverEnvironment.connectExtensionHost, {
    reportFailure: false,
    reportDefect: false,
  });

  useEffect(() => {
    const host = element.current;
    if (!host || !httpBaseUrl) return;
    let cancelled = false;
    let attached: ReturnType<typeof attachPart> | undefined;
    let editorListener: { dispose(): void } | undefined;
    let themeObserver: MutationObserver | undefined;
    void (async () => {
      const runtime = await getRuntime(
        async () => {
          const result = await connect({ environmentId, input: {} });
          if (result._tag !== "Success")
            throw new Error("Could not connect to the extension host.");
          return result.value;
        },
        httpBaseUrl,
        workspaceRoot,
      );
      if (cancelled) return;
      if (
        target.kind === "extension-webview" &&
        !(await showWebview(extensionId, target.viewType, target.resource))
      ) {
        throw new Error("This extension panel closed. Run its command again to reopen it.");
      }
      if (cancelled) return;
      if (target.kind === "extension-webview") {
        showEditor(host);
        editorListener = runtime.editors.onDidActiveEditorChange(() => {
          void activeWebview(extensionId).then((webview) => {
            if (cancelled || !webview || webview.resource === target.resource) return;
            onOpenWebview?.(webview);
          });
        });
      } else attached = attachPart(Parts.SIDEBAR_PART, host);
      if (target.kind === "extension") {
        const viewId = target.viewContainerId ?? firstViewContainerId;
        if (viewId && !(await openViewContainer(`workbench.view.extension.${viewId}`))) {
          throw new Error("This extension's view is not available.");
        }
        if (cancelled) return;
        editorListener = runtime.editors.onDidActiveEditorChange(() => {
          void activeWebview(extensionId).then((webview) => {
            if (!cancelled && webview) onOpenWebview?.(webview);
          });
        });
      }
      const updateTheme = () => void syncTheme(host);
      updateTheme();
      themeObserver = new MutationObserver(updateTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    })().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      editorListener?.dispose();
      attached?.dispose();
      if (target.kind === "extension-webview") parkEditor();
      themeObserver?.disconnect();
    };
  }, [
    connect,
    httpBaseUrl,
    environmentId,
    extensionId,
    firstViewContainerId,
    onOpenWebview,
    target,
    workspaceRoot,
  ]);

  if (error) return <div className="p-5 text-sm text-muted-foreground">{error}</div>;
  return <div ref={element} className="t3-vscode-part h-full min-h-0 w-full overflow-hidden" />;
}
