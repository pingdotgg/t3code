// @effect-diagnostics globalTimers:off - This isolated Electron preload does not run inside an Effect runtime.
// Gives the annotation overlay its `window.__CONN_ANNOTATIONS__`. The preload shares `window`
// with the page (contextIsolation is off); each call goes to the hosting renderer, which
// answers from the Conn server (apps/web/src/annotations/overlayBridge.ts).
import type { AnnotationCapture } from "@t3tools/contracts";
import { ipcRenderer } from "electron";
import { ANNOTATION_REGION_CAPTURE_CHANNEL } from "./GuestProtocol.ts";
import {
  ANNOTATION_BRIDGE_CHANNEL,
  CONN_ANNOTATIONS_GLOBAL,
  isAnnotationBridgeMessage,
  type AnnotationBridgeOperation,
} from "@t3tools/shared/annotationBridge";

const REQUEST_TIMEOUT_MS = 15_000;

const pending = new Map<
  string,
  { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
>();
const listeners = new Set<() => void>();
let nextRequest = 0;

ipcRenderer.on(ANNOTATION_BRIDGE_CHANNEL, (_event, message: unknown) => {
  if (!isAnnotationBridgeMessage(message)) return;
  if (message.type === "changed") {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
    return;
  }
  const request = pending.get(message.requestId);
  if (!request) return;
  pending.delete(message.requestId);
  if (message.ok) request.resolve(message.value);
  else request.reject(new Error(message.error));
});

function call(operation: AnnotationBridgeOperation): Promise<unknown> {
  const requestId = `${++nextRequest}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Conn did not answer."));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    ipcRenderer.sendToHost(ANNOTATION_BRIDGE_CHANNEL, { ...operation, requestId });
  });
}

// Structured clone needs plain data; page objects may carry prototypes or functions.
const plain = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A;

// Configurable: a server-driven tab replaces it with the server's own binding.
Object.defineProperty(window, CONN_ANNOTATIONS_GLOBAL, {
  configurable: true,
  enumerable: false,
  value: Object.freeze({
    list: () => call({ op: "list" }),
    submit: (capture: AnnotationCapture) => call({ op: "submit", payload: plain(capture) }),
    remove: async (ids: ReadonlyArray<string>) => {
      await call({ op: "remove", payload: { ids: [...ids] } });
    },
    capture: (rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(ANNOTATION_REGION_CAPTURE_CHANNEL, plain(rect)) as Promise<string | null>,
    subscribe: (onChange: () => void) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  }),
});
