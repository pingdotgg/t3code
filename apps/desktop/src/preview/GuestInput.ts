// CDP input follows shared window focus; send directly to unfocused guests to avoid typing into the app.
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

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
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => {
  const host = webContents.hostWebContents;
  if (!host || host.isDestroyed() || webContents.focusedFrame) {
    return debuggee.sendCommand(method, params, sessionId);
  }
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
    return await debuggee.sendCommand(method, params, sessionId);
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

const pointerCommands = new WeakMap<Electron.WebContents, Promise<unknown>>();

/** Focus capture crosses processes; later pointer events must not overtake the press. */
const sendPointerCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => {
  const previous = pointerCommands.get(webContents) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() =>
      params["type"] === "mousePressed" || params["type"] === "touchStart"
        ? sendPointerPress(webContents, debuggee, method, params, sessionId)
        : debuggee.sendCommand(method, params, sessionId),
    );
  pointerCommands.set(webContents, current);
  try {
    return await current;
  } finally {
    if (pointerCommands.get(webContents) === current) pointerCommands.delete(webContents);
  }
};

const SCREENSHOT_DEADLINE = "5 seconds";
const SCREENSHOT_RETRY = "50 millis";
const pendingViewportCopies = new WeakMap<Electron.WebContents, Promise<Electron.NativeImage>>();

const copyViewport = (
  webContents: Electron.WebContents,
  signal: AbortSignal,
): Promise<Electron.NativeImage> => {
  signal.throwIfAborted();
  const pending = pendingViewportCopies.get(webContents);
  if (pending) return pending.catch(() => undefined).then(() => copyViewport(webContents, signal));
  const copy = webContents.capturePage().finally(() => {
    if (pendingViewportCopies.get(webContents) === copy) pendingViewportCopies.delete(webContents);
  });
  pendingViewportCopies.set(webContents, copy);
  return copy;
};

class PreviewScreenshotError extends Schema.TaggedError<PreviewScreenshotError>()(
  "PreviewScreenshotError",
  { reason: Schema.Literals(["unpainted", "timeout"]) },
) {
  override get message(): string {
    return this.reason === "timeout"
      ? `The preview tab did not paint within ${SCREENSHOT_DEADLINE}.`
      : "The preview tab has not painted yet.";
  }
}

/** Whether capturePage can stand in for this screenshot; a clip or full page goes to Chromium. */
const capturesViewport = (params: Record<string, unknown>) =>
  Object.entries(params).every(([name, value]) => {
    switch (name) {
      case "format":
        return value === "png" || value === "jpeg";
      case "fromSurface":
        return value !== false;
      case "captureBeyondViewport":
        return value !== true;
      case "quality":
      case "optimizeForSpeed":
        return true;
      default:
        return false;
    }
  });

/**
 * Page.captureScreenshot waits for a presented frame, which Chromium may never present for a
 * guest the app paints behind itself. capturePage copies the surface instead. That surface exists
 * only once the client paints the guest, so a refused copy is retried; a stalled one is not overlapped.
 */
const captureViewport = (webContents: Electron.WebContents, params: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.tryPromise({
      try: (signal) => copyViewport(webContents, signal),
      catch: () => new PreviewScreenshotError({ reason: "unpainted" }),
    }).pipe(
      Effect.filterOrFail(
        (image) => !image.isEmpty(),
        () => new PreviewScreenshotError({ reason: "unpainted" }),
      ),
      Effect.retry({
        schedule: Schedule.spaced(SCREENSHOT_RETRY),
        while: () => !webContents.isDestroyed(),
      }),
      Effect.timeoutOrElse({
        duration: SCREENSHOT_DEADLINE,
        orElse: () => Effect.fail(new PreviewScreenshotError({ reason: "timeout" })),
      }),
      Effect.map((image) => {
        const quality = typeof params["quality"] === "number" ? params["quality"] : 80;
        const encoded = params["format"] === "jpeg" ? image.toJPEG(quality) : image.toPNG();
        return { data: encoded.toString("base64") };
      }),
    ),
  );

/** Sends one command to the guest's page, keeping reloads, screenshots and input inside it. */
export const sendPageCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<unknown> => {
  if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchTouchEvent") {
    return sendPointerCommand(webContents, debuggee, method, params, sessionId);
  }
  if (sessionId !== undefined) return debuggee.sendCommand(method, params, sessionId);
  // Electron's debugger routes Page.reload on a webview to its embedder window.
  if (method === "Page.reload") {
    if (params["ignoreCache"] === true) webContents.reloadIgnoringCache();
    else webContents.reload();
    return {};
  }
  if (method === "Page.captureScreenshot" && capturesViewport(params)) {
    return captureViewport(webContents, params);
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
