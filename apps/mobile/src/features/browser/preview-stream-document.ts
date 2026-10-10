import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type { PreviewStreamHostSetup } from "@t3tools/contracts";
import type {
  PreviewStreamControl,
  PreviewStreamDownload,
  PreviewStreamFileChooser,
  PreviewStreamPasskeyRequest,
} from "@t3tools/client-runtime/preview/server-browser-stream";

export interface PreviewStreamConfiguration {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Taps, scrolls, keys, and `resize` to the view size. The floating player only watches. */
  readonly interactive: boolean;
  readonly background: string;
  /** This device answers the page's passkey requests; offered to the server with control. */
  readonly passkeys: boolean;
}

/** Messages the WebView document posts to the native view. */
export type PreviewStreamMessage =
  | ({ readonly type: "control" } & PreviewStreamControl)
  | {
      readonly type: "status";
      readonly status: "connecting" | "streaming" | "error";
      readonly detail?: string;
    }
  | { readonly type: "unauthorized" }
  | { readonly type: "gone" }
  | ({ readonly type: "hostSetup" } & PreviewStreamHostSetup)
  | { readonly type: "viewport"; readonly width: number; readonly height: number }
  | { readonly type: "clipboard"; readonly text: string }
  /** The input that types into page fields gained or lost focus. */
  | { readonly type: "input"; readonly focused: boolean }
  | ({ readonly type: "download" } & PreviewStreamDownload)
  | { readonly type: "fileChooser"; readonly chooser: PreviewStreamFileChooser | null }
  | { readonly type: "passkey"; readonly request: PreviewStreamPasskeyRequest }
  | { readonly type: "passkeyCancel"; readonly id: string }
  | {
      readonly type: "pictureInPicture";
      readonly supported: boolean;
      readonly active: boolean;
      readonly detail?: string;
    };

export function previewStreamDocument(configuration: string, script: string) {
  // Tickets and URLs are data, including any HTML delimiter characters.
  const safeConfiguration = configuration.replace(/</g, "\\u003c");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const failure = `window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:"Browser viewer stopped unexpectedly."}));`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html, body { height: 100%; overflow: hidden; }
  body { margin: 0; }
  body > div { position: fixed; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; }
  canvas, video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  canvas { touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  video { pointer-events: none; }
  /* The agent's pointer, positioned over the letterboxed frame by the viewer script. */
  .agent-cursor {
    position: absolute; left: 0; top: 0; width: 20px; height: 20px; pointer-events: none;
    opacity: 0; transition: opacity 150ms ease-out, transform 150ms ease-out;
  }
  .agent-cursor svg { position: relative; display: block; filter: drop-shadow(0 1px 1px rgba(0,0,0,.35)); }
  .agent-cursor .ping {
    position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: rgba(59,130,246,.3); animation: agent-cursor-ping 600ms ease-out forwards;
  }
  @keyframes agent-cursor-ping { from { transform: scale(.6); opacity: 1; } to { transform: scale(2.2); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .agent-cursor { transition: none; }
    .agent-cursor .ping { animation: none; opacity: 0; }
  }
  /* Pinned so focus never scrolls; 16px keeps iOS from zooming on focus. */
  textarea {
    position: fixed; left: 0; top: 0; width: 1px; height: 1px;
    padding: 0; margin: -1px; border: 0; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; font-size: 16px;
  }
</style></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{T3PreviewStream.start(${safeConfiguration});}catch{${failure}}</script></body></html>`;
}

export function previewStreamMessage(data: string): PreviewStreamMessage | null {
  try {
    // Only our bundled viewer runs in this WebView; the remote page never does.
    return JSON.parse(data) as PreviewStreamMessage;
  } catch {
    return null;
  }
}
