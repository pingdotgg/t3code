import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";

export interface PreviewStreamConfiguration {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Taps, scrolls, keys, and `resize` to the view size. The floating player only watches. */
  readonly interactive: boolean;
  readonly background: string;
}

/** Messages the WebView document posts to the native view. */
export type PreviewStreamMessage =
  | {
      readonly type: "status";
      readonly status: "connecting" | "streaming" | "error";
      readonly detail?: string;
    }
  | { readonly type: "unauthorized" }
  | { readonly type: "gone" }
  | { readonly type: "viewport"; readonly width: number; readonly height: number }
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
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{T3PreviewStream.start(${safeConfiguration});}catch{${failure}}</script></body></html>`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function previewStreamMessage(data: string): PreviewStreamMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    // Ignore messages that are not part of the stream bridge.
    return null;
  }
  if (!isRecord(message)) return null;
  const detail = typeof message.detail === "string" ? message.detail : undefined;
  switch (message.type) {
    case "unauthorized":
    case "gone":
      return { type: message.type };
    case "status":
      return message.status === "connecting" ||
        message.status === "streaming" ||
        message.status === "error"
        ? { type: "status", status: message.status, ...(detail ? { detail } : {}) }
        : null;
    case "viewport":
      return typeof message.width === "number" && typeof message.height === "number"
        ? { type: "viewport", width: message.width, height: message.height }
        : null;
    case "pictureInPicture":
      return typeof message.supported === "boolean" && typeof message.active === "boolean"
        ? {
            type: "pictureInPicture",
            supported: message.supported,
            active: message.active,
            ...(detail ? { detail } : {}),
          }
        : null;
    default:
      return null;
  }
}
