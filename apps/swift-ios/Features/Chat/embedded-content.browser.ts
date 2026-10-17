import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  mcpResourceBytes,
  type McpAppCallToolResult,
  type McpAppDisplayMode,
} from "../../../../packages/client-runtime/src/mcpApps/host.ts";
import {
  mcpAppAllowAttribute,
  readMcpAppReference,
} from "../../../../packages/shared/src/mcpApp.ts";

type NativeOperation =
  | "toolInfo"
  | "callTool"
  | "readResource"
  | "updateModelContext"
  | "openLink"
  | "sendMessage"
  | "displayMode"
  | "download"
  | "close"
  | "failure";
interface Configuration {
  documentID: string;
  url: string;
  app: unknown;
  input: unknown;
  result: McpAppCallToolResult;
  tool?: unknown;
  fullscreen: boolean;
  locale: string;
  timeZone: string;
  variables: Record<string, string>;
}
interface NativeBridge {
  postMessage(message: {
    documentID: string;
    id: number;
    operation: NativeOperation;
    payload: unknown;
  }): void;
}
declare global {
  interface Window {
    webkit: { messageHandlers: { embedded: NativeBridge } };
    t3Embedded: {
      start(configuration: Configuration): void;
      reply(documentID: string, id: number, result: unknown, error: string | null): void;
      teardown(): Promise<void>;
    };
  }
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
let activeID: string | undefined;
let serial = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
let dispose: (() => Promise<void>) | undefined;

function call(operation: NativeOperation, payload: unknown = {}): Promise<unknown> {
  const documentID = activeID;
  if (!documentID || pending.size >= 16)
    return Promise.reject(new McpAppHostRefusal("App is unavailable."));
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // WebKit message handlers do not accept a target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    window.webkit.messageHandlers.embedded.postMessage({ documentID, id, operation, payload });
  });
}

function notify(operation: "failure" | "close") {
  if (!activeID) return;
  // WebKit message handlers do not accept a target origin.
  /* oxlint-disable unicorn/require-post-message-target-origin */
  window.webkit.messageHandlers.embedded.postMessage({
    documentID: activeID,
    id: ++serial,
    operation,
    payload: {},
  });
  /* oxlint-enable unicorn/require-post-message-target-origin */
}

function stop() {
  activeID = undefined;
  for (const request of pending.values()) request.reject(new McpAppHostRefusal("App closed."));
  pending.clear();
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}

window.t3Embedded = {
  start(config) {
    stop();
    const app = readMcpAppReference(config.app);
    if (!app) return;
    activeID = config.documentID;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.setAttribute("allow", mcpAppAllowAttribute(app.permissions));
    frame.style.cssText = "border:0;width:100%;height:100%;display:block;background:#000";
    let loads = 0;
    let mode: McpAppDisplayMode = config.fullscreen ? "fullscreen" : "inline";
    const host = makeMcpAppHost({
      app,
      hostVersion: "1.0.0",
      post: (message) => frame.contentWindow?.postMessage(message, "*"),
      hostContext: () => ({
        theme: "dark",
        styles: { variables: mcpAppStyleVariables(config.variables) },
        displayMode: mode,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { width: window.innerWidth, height: window.innerHeight },
        platform: "mobile",
        locale: config.locale,
        timeZone: config.timeZone,
        deviceCapabilities: { touch: true, hover: false },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        ...(config.tool === undefined ? {} : { toolInfo: { tool: config.tool } }),
      }),
      callTool: async (input) => (await call("callTool", input)) as McpAppCallToolResult,
      readResource: (input) => call("readResource", input),
      openLink: async (url) => {
        await call("openLink", { url });
      },
      sendMessage: async (text) => {
        await call("sendMessage", { text });
      },
      updateModelContext: async (context) => {
        await call("updateModelContext", context);
      },
      requestDisplayMode: async (requested) => {
        const accepted = await call("displayMode", { mode: requested });
        if (accepted !== "inline" && accepted !== "fullscreen")
          throw new McpAppHostRefusal("Display mode is unavailable.");
        mode = accepted;
        return mode;
      },
      downloadFile: async (files) => {
        // Confirmation precedes resource reads as well as sharing.
        await call("download", { phase: "confirm", names: files.map((file) => file.name) });
        try {
          for (const [index, file] of files.entries()) {
            let bytes: Uint8Array | undefined;
            if (file._tag === "embedded") bytes = file.bytes;
            else {
              const resource = await call("readResource", { uri: file.uri });
              if (
                typeof resource === "object" &&
                resource !== null &&
                "contents" in resource &&
                Array.isArray(resource.contents)
              ) {
                bytes = mcpResourceBytes(resource.contents[0]);
              }
            }
            if (!bytes || bytes.length > MAX_FILE_BYTES)
              throw new McpAppHostRefusal("File is unavailable or exceeds 25 MiB.");
            await call("download", {
              phase: "file",
              index,
              name: file.name,
              base64: base64(bytes),
            });
          }
          await call("download", { phase: "share" });
        } catch (error) {
          await call("download", { phase: "cancel" }).catch(() => {});
          throw error;
        }
      },
      onRequestTeardown: () => {
        notify("close");
      },
      onSizeChanged: () => {}, // Inline app frames have a fixed 420 CSS pixel height.
    });
    const receive = (event: MessageEvent<unknown>) => {
      if (activeID === config.documentID && event.source === frame.contentWindow)
        host.receive(event.data);
    };
    window.addEventListener("message", receive);
    const resize = () => host.updateHostContext();
    window.addEventListener("resize", resize);
    frame.addEventListener("load", () => {
      if (++loads > 1) {
        notify("failure");
        stop();
        host.dispose();
        window.removeEventListener("message", receive);
      }
    });
    host.setToolCall({ arguments: config.input, result: config.result });
    frame.src = config.url;
    document.body.replaceChildren(frame);
    dispose = async () => {
      await host.teardown();
      stop();
      window.removeEventListener("message", receive);
      window.removeEventListener("resize", resize);
      frame.remove();
    };
  },
  reply(documentID, id, result, error) {
    if (documentID !== activeID) return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new McpAppHostRefusal(error));
    else request.resolve(result);
  },
  async teardown() {
    await dispose?.();
    dispose = undefined;
  },
};
