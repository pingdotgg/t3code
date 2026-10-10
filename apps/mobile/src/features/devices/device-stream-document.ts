import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type { DevicePlatform } from "@t3tools/contracts";

export interface DeviceStreamConfiguration {
  readonly access: DeviceHubAccess;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly colors: {
    readonly background: string;
    readonly foreground: string;
    readonly muted: string;
    readonly buttonBackground: string;
    readonly buttonForeground: string;
    readonly buttonBorder: string;
  };
}

export function deviceStreamBaseUrl(
  viewerPlatform: string,
  devicePlatform: DevicePlatform,
  httpBase: string,
) {
  if (viewerPlatform !== "android") return "file:///";
  // iOS targets use an MJPEG image. A synthetic HTTPS origin makes Android
  // block HTTP image streams as mixed content, even with mixedContentMode="always".
  if (devicePlatform === "ios") return `${new URL(httpBase).origin}/`;
  // Android targets use WebCodecs, which requires a secure document.
  return "https://localhost/";
}

export function deviceStreamDocument(configuration: string, script: string) {
  // Tickets and device names are data, including any HTML delimiter characters.
  const safeConfiguration = configuration.replace(/</g, "\\u003c");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const failure = `window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:"Device viewer stopped unexpectedly."}));`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{T3DeviceStream.start(${safeConfiguration});}catch{${failure}}</script></body></html>`;
}

export function deviceStreamMessage(data: string) {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null || !("type" in message)) return null;
    if (message.type === "unauthorized" || message.type === "retry") {
      return { type: message.type } as const;
    }
    if (
      message.type === "input" &&
      "connected" in message &&
      typeof message.connected === "boolean"
    ) {
      return { type: message.type, connected: message.connected } as const;
    }
    if (
      message.type === "status" &&
      "status" in message &&
      (message.status === "connecting" ||
        message.status === "streaming" ||
        message.status === "error") &&
      (!("detail" in message) || typeof message.detail === "string")
    ) {
      return {
        type: message.type,
        status: message.status,
        detail:
          "detail" in message && typeof message.detail === "string" ? message.detail : undefined,
      } as const;
    }
  } catch {
    // Ignore messages that are not part of the stream bridge.
  }
  return null;
}
