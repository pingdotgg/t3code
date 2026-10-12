/**
 * The web and desktop side of a mounted plugin view, kept free of React so
 * the handshake and lifetime rules can be tested without a DOM.
 *
 * `resolvePluginViewTarget` decides whether a plugin-view surface mounts and
 * under which key; a new key is a new mount, and the old one is torn down.
 * `awaitPluginViewReady` is the only window-message listener: it hands the
 * view exactly one port. `runPluginViewMount` serves that port through the
 * shared bridge until its scope closes.
 */
import type { PluginViewsView } from "@t3tools/client-runtime/state/pluginViews";
import {
  makePluginViewBridge,
  type PluginViewCloseReason,
} from "@t3tools/client-runtime/plugin-views/bridge";
import {
  PLUGIN_VIEW_CONNECT_MESSAGE,
  PLUGIN_VIEW_READY_MESSAGE,
  type PluginView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

type PluginViewTarget =
  /** No session or no snapshot yet. */
  | { readonly _tag: "waiting" }
  /** The environment's server cannot serve views. */
  | { readonly _tag: "unsupported" }
  /** Not offered now: disabled, removed, changed on disk, still loading, or invalid (`problem`). */
  | { readonly _tag: "unavailable"; readonly problem: string | null }
  | { readonly _tag: "mount"; readonly view: PluginView; readonly key: string };

/**
 * Where a plugin-view surface stands in the current session's snapshot. The
 * caller passes only a snapshot that session produced. The mount key
 * changes with the session and the generation, so a reconnect, re-enable or
 * restart ends the old mount before the new one starts.
 */
export function resolvePluginViewTarget(input: {
  /** The snapshot from `session`, or null before it has sent one. */
  readonly views: PluginViewsView | null;
  readonly surface: { readonly installationId: string; readonly viewId: string };
  /** Identifies the environment's current session; null while it has none. */
  readonly session: number | null;
}): PluginViewTarget {
  const { views, surface, session } = input;
  if (session === null || views === null) return { _tag: "waiting" };
  if (views._tag === "unsupported") return { _tag: "unsupported" };
  const view = views.views.find(
    (candidate) =>
      candidate.installationId === surface.installationId &&
      candidate.viewId === surface.viewId &&
      candidate.placement === "side-panel",
  );
  if (view === undefined)
    return {
      _tag: "unavailable",
      problem:
        views.problems.find((problem) => problem.installationId === surface.installationId)
          ?.message ?? null,
    };
  return {
    _tag: "mount",
    view,
    key: `${session}:${view.installationId}:${view.generation}:${view.viewId}`,
  };
}

const sessionEpochs = new WeakMap<object, number>();
let lastSessionEpoch = 0;

/** A number per session object, for mount keys; null while there is no session. */
export function sessionEpoch(session: object | null): number | null {
  if (session === null) return null;
  let epoch = sessionEpochs.get(session);
  if (epoch === undefined) {
    lastSessionEpoch += 1;
    epoch = lastSessionEpoch;
    sessionEpochs.set(session, epoch);
  }
  return epoch;
}

interface MessageSourceWindow {
  readonly postMessage: (message: unknown, targetOrigin: string, transfer: Transferable[]) => void;
}

/**
 * Waits for the view's `ready` and answers it with one `connect` carrying one
 * port. Only a message whose source is the view's window (the wrapper frame's
 * child) is read at all; once connected, the listener is gone, so a second
 * `ready` never gets a port. Returns a function that stops waiting.
 */
export function awaitPluginViewReady(options: {
  readonly host: Pick<Window, "addEventListener" | "removeEventListener">;
  /** The view's window now; it can change if the view navigates. */
  readonly viewWindow: () => unknown;
  readonly onConnect: (port: MessagePort) => void;
}): () => void {
  const listener = (event: MessageEvent) => {
    const source = event.source;
    if (source === null || source !== options.viewWindow()) return;
    const data: unknown = event.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== PLUGIN_VIEW_READY_MESSAGE
    )
      return;
    stop();
    const channel = new MessageChannel();
    // The view's origin is opaque, so "*" is the only target that reaches it.
    (source as unknown as MessageSourceWindow).postMessage(
      { type: PLUGIN_VIEW_CONNECT_MESSAGE },
      "*",
      [channel.port2],
    );
    options.onConnect(channel.port1);
  };
  const stop = () => options.host.removeEventListener("message", listener);
  options.host.addEventListener("message", listener);
  return stop;
}

/**
 * Serves one connected view until the scope closes. Every port message goes
 * to the bridge with its transferred port count; the bridge closes the port
 * and reports `onClose` once, whatever ends the mount.
 */
export const runPluginViewMount = Effect.fnUntraced(function* <E, R>(options: {
  readonly port: MessagePort;
  readonly view: Pick<PluginView, "pluginId" | "viewId" | "title">;
  /** Bound by the host to the mount's environment, installation, generation and view. */
  readonly call: (handler: string, input: Schema.Json) => Effect.Effect<Schema.Json, E, R>;
  readonly onClose: (reason: PluginViewCloseReason) => void;
}) {
  const { port } = options;
  const bridge = yield* makePluginViewBridge({
    view: {
      pluginId: options.view.pluginId,
      viewId: options.view.viewId,
      title: options.view.title,
    },
    port: { post: (text) => port.postMessage(text), close: () => port.close() },
    call: options.call,
    onClose: options.onClose,
  });
  port.addEventListener("message", (event) => bridge.receive(event.data, event.ports.length));
  // A message that could not be deserialized is not text.
  port.addEventListener("messageerror", () => bridge.receive(undefined, 0));
  port.start();
  return yield* Effect.never;
});
