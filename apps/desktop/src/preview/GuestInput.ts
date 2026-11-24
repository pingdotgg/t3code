// CDP input follows shared window focus; send directly to unfocused guests to avoid typing into the app.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const FOCUS_ROUTED_INPUT = new Set([
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Input.imeSetComposition",
]);

/** Direct input reaches only the main-frame process; insertText crashes when a cross-site frame has focus. */
const FOCUSED_DOCUMENT = `(() => {
  let doc = document;
  for (;;) {
    const active = doc.activeElement;
    if (active?.tagName !== "IFRAME" && active?.tagName !== "FRAME") return doc;
    if (!active.contentDocument) return null;
    doc = active.contentDocument;
  }
})()`;

/** Electron runs editing commands only for CDP keys; exclude clipboard commands to preserve the user's clipboard. */
const EDITING_COMMANDS = new Set(["selectAll", "undo", "redo"]);

const CROSS_SITE_FOCUS_MESSAGE =
  "The page's focus is inside a cross-site frame, which takes typed input only while the preview has focus. Click the field first.";

const ARROW_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
const NAMED_KEYS = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
]);
const MODIFIER_BITS = [
  [1, "alt"],
  [2, "control"],
  [4, "meta"],
  [8, "shift"],
] as const;

const keyCodeFor = (key: string) => {
  if ([...key].length === 1) return key;
  if (ARROW_KEYS[key]) return ARROW_KEYS[key];
  return NAMED_KEYS.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) ? key : null;
};

/** Electron derives text from keyCode, so typed text needs separate char events. */
export const toKeyboardInputEvents = (
  params: Record<string, unknown>,
): Array<Electron.KeyboardInputEvent> => {
  const bits = typeof params["modifiers"] === "number" ? params["modifiers"] : 0;
  const modifiers = MODIFIER_BITS.flatMap(([bit, name]) => (bits & bit ? [name] : []));
  const text = typeof params["text"] === "string" ? params["text"] : "";
  const chars = [...text].map((char) => ({ type: "char" as const, keyCode: char, modifiers }));
  const keyCode = keyCodeFor(typeof params["key"] === "string" ? params["key"] : "");
  switch (params["type"]) {
    case "keyDown":
      return [...(keyCode ? [{ type: "rawKeyDown" as const, keyCode, modifiers }] : []), ...chars];
    case "rawKeyDown":
    case "keyUp":
      return keyCode ? [{ type: params["type"], keyCode, modifiers }] : [];
    case "char":
      return chars;
    default:
      return [];
  }
};

const evaluate = async (debuggee: Electron.Debugger, expression: string) => {
  const reply = (await debuggee.sendCommand("Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { readonly result?: { readonly value?: unknown } };
  return reply.result?.value;
};

/** Host focus shared by the presses in flight in one window, so a later press keeps the field an earlier one saved. */
const HOST_FOCUS = "globalThis.__t3PreviewFocus";

/** A CDP pointer press focuses the guest's native view even with focus emulation enabled. */
const sendPointerPress = async (
  webContents: Electron.WebContents,
  dispatch: () => Promise<unknown>,
) => {
  const host = webContents.hostWebContents;
  if (!host || host.isDestroyed() || webContents.focusedFrame) return dispatch();
  // Focus in a webview with a press in flight came from that press, so keep the earlier save.
  await host.executeJavaScript(`(() => {
    const state = (${HOST_FOCUS} ??= { saved: null, presses: [] });
    const active = document.activeElement;
    let pressed = false;
    try {
      pressed = active?.tagName === "WEBVIEW" && state.presses.includes(active.getWebContentsId());
    } catch {}
    if (!pressed) {
      state.saved = active && active !== document.body && active.tagName !== "WEBVIEW" ? active : null;
    }
    state.presses.push(${webContents.id});
  })()`);
  try {
    return await dispatch();
  } finally {
    if (!host.isDestroyed()) {
      // Membership check: a host reload starts a new state without this press.
      await host.executeJavaScript(`(() => {
        const state = ${HOST_FOCUS};
        const index = state ? state.presses.indexOf(${webContents.id}) : -1;
        if (index < 0) return;
        state.presses.splice(index, 1);
        if (state.presses.length === 0) delete ${HOST_FOCUS};
        const current = document.activeElement;
        try {
          if (state.saved?.isConnected && current?.tagName === "WEBVIEW" &&
              current.getWebContentsId() === ${webContents.id}) state.saved.focus({ preventScroll: true });
        } catch {}
      })()`);
    }
  }
};

/** Calls `listener` once the frame session detaches, at once if it already has; returns a stop. */
export type FrameDetachWatch = (sessionId: string, listener: () => void) => () => void;

interface FrameRoute {
  readonly params: Record<string, unknown>;
  readonly sessionId: string;
  readonly onDetach: FrameDetachWatch;
}

/** Moves a page point into the cross-site frame under it, if one has a session; null when none does. */
export type PointerRoute = (params: Record<string, unknown>) => Promise<FrameRoute | null>;

const FRAME_GONE_MESSAGE =
  "The frame under the pointer went away before it took this input. Check the page before retrying.";

const MAX_FRAME_DEPTH = 8;
const ROUTE_DEADLINE = "1 second";

/**
 * Chromium picks a pointer event's frame by hit-testing what the window composites, so on a
 * guest the window does not show, input over a cross-site frame lands on the page instead.
 * That frame's own session takes the event at frame-local coordinates.
 */
export const routeMouseToFrame =
  (
    debuggee: Electron.Debugger,
    frameSessions: ReadonlyMap<string, string>,
    onDetach: FrameDetachWatch,
  ): PointerRoute =>
  async (params) => {
    // A wheel over a frame that cannot scroll would no longer reach the page behind it.
    if (params["type"] === "mouseWheel" || frameSessions.size === 0) return null;
    // Chromium never answers a lookup on a frame that detaches mid-navigation; the page takes it.
    const routed = await Effect.runPromise(
      Effect.promise(() => locateFrame(debuggee, frameSessions, params)).pipe(
        Effect.timeoutOption(ROUTE_DEADLINE),
        Effect.map(Option.getOrNull),
      ),
    );
    if (!routed || ![...frameSessions.values()].includes(routed.sessionId)) return null;
    return { ...routed, onDetach };
  };

/** Chromium can drop the reply to input on a frame that detaches before acknowledging it. */
const sendToFrame = (debuggee: Electron.Debugger, method: string, route: FrameRoute) =>
  new Promise<unknown>((resolve, reject) => {
    let gone = false;
    const stop = route.onDetach(route.sessionId, () => {
      gone = true;
      reject(new Error(FRAME_GONE_MESSAGE));
    });
    if (gone) return;
    debuggee.sendCommand(method, route.params, route.sessionId).then(resolve, reject).finally(stop);
  });

const locateFrame = async (
  debuggee: Electron.Debugger,
  frameSessions: ReadonlyMap<string, string>,
  params: Record<string, unknown>,
) => {
  let { x, y } = params;
  if (typeof x !== "number" || typeof y !== "number") return null;
  let sessionId: string | undefined;
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    try {
      const { cssLayoutViewport: scroll } = (await debuggee.sendCommand(
        "Page.getLayoutMetrics",
        {},
        sessionId,
      )) as { readonly cssLayoutViewport: { readonly pageX: number; readonly pageY: number } };
      // The lookup takes whole document pixels; the event and box model use the viewport.
      const { backendNodeId } = (await debuggee.sendCommand(
        "DOM.getNodeForLocation",
        {
          x: Math.round(x + scroll.pageX),
          y: Math.round(y + scroll.pageY),
          includeUserAgentShadowDOM: true,
        },
        sessionId,
      )) as { readonly backendNodeId: number };
      const { node } = (await debuggee.sendCommand(
        "DOM.describeNode",
        { backendNodeId },
        sessionId,
      )) as { readonly node: { readonly frameId?: string } };
      // A cross-site frame's target id is its frame id; a same-site frame has no session,
      // and a document's own root element names the frame it is already in.
      const frameSession = node.frameId === undefined ? undefined : frameSessions.get(node.frameId);
      if (frameSession === undefined || frameSession === sessionId) break;
      const { model } = (await debuggee.sendCommand(
        "DOM.getBoxModel",
        { backendNodeId },
        sessionId,
      )) as { readonly model: { readonly content: ReadonlyArray<number> } };
      const xs = model.content.filter((_, index) => index % 2 === 0);
      const ys = model.content.filter((_, index) => index % 2 === 1);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      // The frame owner's border and padding belong to the page.
      if (x < left || x >= Math.max(...xs) || y < top || y >= Math.max(...ys)) break;
      x -= left;
      y -= top;
      sessionId = frameSession;
    } catch {
      break;
    }
  }
  return sessionId === undefined ? null : { params: { ...params, x, y }, sessionId };
};

const pointerCommands = new WeakMap<Electron.WebContents, Promise<unknown>>();

/** Focus capture crosses processes; later pointer events must not overtake the press. */
const sendPointerCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  route: PointerRoute | undefined,
) => {
  const previous = pointerCommands.get(webContents) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      const routed = route && sessionId === undefined ? await route(params) : null;
      const dispatch = routed
        ? () => sendToFrame(debuggee, method, routed)
        : () => debuggee.sendCommand(method, params, sessionId);
      return params["type"] === "mousePressed" || params["type"] === "touchStart"
        ? sendPointerPress(webContents, dispatch)
        : dispatch();
    });
  pointerCommands.set(webContents, current);
  try {
    return await current;
  } finally {
    if (pointerCommands.get(webContents) === current) pointerCommands.delete(webContents);
  }
};

/** Sends one command to the guest's page, keeping reloads and input inside it. */
export const sendPageCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
  routeMouse?: PointerRoute,
): Promise<unknown> => {
  if (method === "Input.dispatchMouseEvent") {
    return sendPointerCommand(webContents, debuggee, method, params, sessionId, routeMouse);
  }
  if (method === "Input.dispatchTouchEvent") {
    return sendPointerCommand(webContents, debuggee, method, params, sessionId, undefined);
  }
  if (sessionId !== undefined) return debuggee.sendCommand(method, params, sessionId);
  // Electron's debugger routes Page.reload on a webview to its embedder window.
  if (method === "Page.reload") {
    if (params["ignoreCache"] === true) webContents.reloadIgnoringCache();
    else webContents.reload();
    return {};
  }
  if (method === "Page.stopLoading") {
    webContents.stop();
    return {};
  }
  if (!FOCUS_ROUTED_INPUT.has(method) || webContents.focusedFrame) {
    return debuggee.sendCommand(method, params);
  }
  if ((await evaluate(debuggee, `${FOCUSED_DOCUMENT} !== null`)) !== true) {
    throw new Error(CROSS_SITE_FOCUS_MESSAGE);
  }
  switch (method) {
    case "Input.insertText":
      await webContents.insertText(typeof params["text"] === "string" ? params["text"] : "");
      return {};
    case "Input.dispatchKeyEvent": {
      for (const event of toKeyboardInputEvents(params)) webContents.sendInputEvent(event);
      const commands = Array.isArray(params["commands"])
        ? params["commands"].filter((command) => EDITING_COMMANDS.has(command))
        : [];
      // Runs after the page handles the keys, so the reply also waits for them.
      await evaluate(
        debuggee,
        `(() => { const doc = ${FOCUSED_DOCUMENT}; for (const name of ${JSON.stringify(commands)}) doc?.execCommand(name); return 0; })()`,
      );
      return {};
    }
    default:
      throw new Error(`${method} needs the preview to have focus.`);
  }
};
