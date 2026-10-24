/**
 * Keyboard and text input for a preview tab's page that never lands outside it.
 *
 * Chromium sends a page's CDP key and text input to whichever frame holds focus
 * in the window. A `<webview>` guest shares that focus with the app around it,
 * so while a person works in the app, `Input.insertText` on the guest's own
 * debugger types into the app's focused field. Such input goes through CDP only
 * while the guest holds focus. Otherwise it goes straight to the guest's own
 * widget, which nothing redirects.
 *
 * Mouse input cannot avoid the window's focus: Chromium focuses the guest for
 * any mouse event it receives. An agent's mouse input therefore runs between
 * noting which element of the app had focus and handing it back.
 */

/** CDP input Chromium delivers to the window's focused frame rather than the page's. */
const FOCUS_ROUTED_INPUT = new Set([
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Input.imeSetComposition",
]);

/**
 * Page script: the document holding the page's focus, or null when a cross-site
 * frame holds it. Electron's direct input reaches only the main frame's process,
 * and `insertText` crashes the page when focus is in another one.
 */
const FOCUSED_DOCUMENT = `(() => {
  let doc = document;
  for (;;) {
    const active = doc.activeElement;
    if (active?.tagName !== "IFRAME" && active?.tagName !== "FRAME") return doc;
    if (!active.contentDocument) return null;
    doc = active.contentDocument;
  }
})()`;

/**
 * macOS editing commands a key press asks for (Cmd+A is `selectAll`), which
 * Chromium runs only for CDP keys. Clipboard commands stay out: they would read
 * or replace the person's clipboard.
 */
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

/** Electron's accelerator name for a DOM key value, or null when it has none. */
const keyCodeFor = (key: string) => {
  if ([...key].length === 1) return key;
  if (ARROW_KEYS[key]) return ARROW_KEYS[key];
  return NAMED_KEYS.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) ? key : null;
};

/**
 * The Electron key events for one CDP `Input.dispatchKeyEvent`. Electron
 * derives key, code, and a char's text from `keyCode`, so typed text travels
 * as `char` events of its own.
 */
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

/**
 * Page scripts for the app window around a guest. Chromium makes a guest the
 * window's focus for every mouse event an agent sends it, and nothing gives that
 * focus back, so the person's next keystrokes land in the page. Only the app's
 * own document knows which of its elements had focus.
 */
const HELD_FOCUS = "Symbol.for('t3.previewHostFocus')";
const holdHostFocusScript = (guestId: number) =>
  `(() => { const held = (globalThis[${HELD_FOCUS}] ??= new Map()); held.set(${guestId}, document.activeElement); })()`;
const restoreHostFocusScript = (guestId: number) =>
  `(() => {
    const held = globalThis[${HELD_FOCUS}]; const previous = held?.get(${guestId}); held?.delete(${guestId});
    const current = document.activeElement;
    if (current?.localName !== "webview" || current.getWebContentsId() !== ${guestId}) return;
    if (previous && previous !== current && previous.isConnected) previous.focus({ preventScroll: true });
    if (document.activeElement === current) current.blur();
  })()`;

/**
 * The app's focus held for a guest's agent mouse input. Overlapping events share
 * one hold: a later event would only note the guest an earlier one focused. The
 * hold stays registered while its focus is handed back, so an event arriving
 * then waits for the hand-back and takes a new hold.
 */
const heldHostFocus = new WeakMap<
  Electron.WebContents,
  { inFlight: number; readonly held: Promise<void>; restoring?: Promise<void> }
>();

/** Runs an agent's mouse input in a guest the app does not have focused, then hands the app its focus back. */
const keepingHostFocus = async <A>(webContents: Electron.WebContents, run: () => Promise<A>) => {
  const host = webContents.hostWebContents;
  if (!host || host.isDestroyed()) return run();
  // A host that went away mid-click has no focus left to restore.
  const inHost = async (script: string) => {
    try {
      await host.executeJavaScript(script);
    } catch {}
  };
  let hold = heldHostFocus.get(webContents);
  while (hold?.restoring) {
    await hold.restoring;
    hold = heldHostFocus.get(webContents);
  }
  if (!hold) {
    hold = { inFlight: 0, held: inHost(holdHostFocusScript(webContents.id)) };
    heldHostFocus.set(webContents, hold);
  }
  hold.inFlight += 1;
  try {
    await hold.held;
    return await run();
  } finally {
    hold.inFlight -= 1;
    if (hold.inFlight === 0) {
      hold.restoring = inHost(restoreHostFocusScript(webContents.id));
      await hold.restoring;
      if (heldHostFocus.get(webContents) === hold) heldHostFocus.delete(webContents);
    }
  }
};

/** Sends one command to the guest's page, keeping reloads and input inside it. */
export const sendPageCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> => {
  // Electron's debugger routes Page.reload on a webview to its embedder window.
  if (method === "Page.reload") {
    if (params["ignoreCache"] === true) webContents.reloadIgnoringCache();
    else webContents.reload();
    return {};
  }
  if (
    method === "Input.dispatchMouseEvent" &&
    (!webContents.focusedFrame || heldHostFocus.has(webContents))
  ) {
    return keepingHostFocus(webContents, () => debuggee.sendCommand(method, params));
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
