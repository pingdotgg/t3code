"use client";

import type { DesktopPreviewWebviewConfig, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";

import { previewBridge } from "./previewBridge";
import { usePreviewBridge } from "./usePreviewBridge";

interface Props {
  threadRef: ScopedThreadRef;
  tabId: string;
  /**
   * URL to load on first mount. Subsequent prop changes are ignored — once
   * the webview is live, navigation flows exclusively through the bridge
   * (`previewBridge.navigate`, `goBack`, `goForward`, `refresh`). Otherwise,
   * a snapshot URL update from the server would re-set `<webview src>` and
   * race with the `loadURL` we already issued via the bridge.
   */
  initialUrl: string | null;
  className?: string;
}

interface ElectronWebview extends HTMLElement {
  src: string;
  partition: string;
  preload?: string;
  /**
   * Comma-separated `key=value` web-preferences override. We use it to drop
   * `contextIsolation` so the picker preload can see the guest page's
   * `__REACT_DEVTOOLS_GLOBAL_HOOK__` and resolve component names.
   */
  webpreferences?: string;
  reload: () => void;
  getWebContentsId: () => number;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview;
  }
}

/**
 * Hosts the Electron `<webview>` for a single preview tab. Returns null on
 * web builds. The two-step handshake (createTab → wait for `dom-ready` →
 * registerWebview) is necessary because `getWebContentsId()` only returns a
 * valid id once the embedded contents have parsed; calling it synchronously
 * after mount throws.
 */
export function PreviewWebview({ threadRef, tabId, initialUrl, className }: Props) {
  const [config, setConfig] = useState<DesktopPreviewWebviewConfig | null>(null);
  const webviewRef = useRef<ElectronWebview | null>(null);
  // Capture once at mount; never re-derived from `initialUrl` props later.
  const initialSrcRef = useRef<string>(initialUrl ?? "about:blank");
  const bridge = previewBridge;

  // Per-tab desktop lifecycle: createTab on mount, closeTab on unmount,
  // mirror state into the store, and reflect navigation back to the server.
  usePreviewBridge({ threadRef, tabId });

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge
      .getPreviewConfig()
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // Stable callback ref so React doesn't re-invoke the closure on every
  // commit (otherwise we'd be re-asserting `allowpopups` and re-storing the
  // ref pointer per render, which is harmless but wasteful).
  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as ElectronWebview | null;
    if (node && !node.hasAttribute("allowpopups")) {
      // React's @types declare `allowpopups` as `boolean`, but the runtime
      // doesn't list <webview> in its boolean-attribute allowlist, so
      // passing it via JSX triggers a "received true for a non-boolean
      // attribute" warning. Setting it imperatively bypasses React's prop
      // normalization entirely.
      node.setAttribute("allowpopups", "true");
    }
  }, []);

  useEffect(() => {
    if (!bridge || !config) return;
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      try {
        const id = webview.getWebContentsId();
        if (Number.isFinite(id)) {
          void bridge.registerWebview(tabId, id);
        }
      } catch {
        // The next dom-ready (e.g. cross-document navigation) will retry.
      }
    };
    webview.addEventListener("dom-ready", onDomReady as EventListener);
    // Defensive: dom-ready may have fired between React commit and this
    // effect running. Failures fall through to the listener above.
    try {
      const existing = webview.getWebContentsId();
      if (Number.isFinite(existing)) {
        void bridge.registerWebview(tabId, existing);
      }
    } catch {
      // covered by dom-ready listener
    }

    return () => {
      webview.removeEventListener("dom-ready", onDomReady as EventListener);
    };
  }, [bridge, config, tabId]);

  if (!isElectron || !bridge || !config) return null;

  // `preload` and `webpreferences` are HTML attributes Electron only reads
  // at element-attach time — a state update later in the lifecycle would
  // have no effect. The renderer-attached values are also enforced by the
  // main-process `will-attach-webview` validator (defense in depth).
  return (
    <webview
      ref={setWebviewRef}
      src={initialSrcRef.current}
      partition={config.partition}
      webpreferences={config.webPreferences}
      {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
      data-preview-tab={tabId}
      className={className}
    />
  );
}
