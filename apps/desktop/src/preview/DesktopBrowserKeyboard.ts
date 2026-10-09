// @effect-diagnostics globalTimers:off -- The Electron CDP callback adapter bounds native renderer receipts outside an Effect runtime.
/** Routes Playwright's keyboard packets to the guest, without changing desktop focus. */
export function createDesktopBrowserKeyboard(
  contents: Electron.WebContents,
  debuggee: Electron.Debugger,
  readClipboard: () => Promise<ReadonlyArray<Electron.ClipboardItem>>,
) {
  let pending = 0;
  let sequence = 0;
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const focusedFrame = async () => {
    // Electron's focusedFrame follows native focus and can be null while the
    // desktop owns it. Follow DOM focus instead, including cross-site frames.
    let frame = contents.mainFrame;
    while (true) {
      const index: unknown = await frame.executeJavaScript(`(() => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        if (element?.tagName !== "IFRAME" && element?.tagName !== "FRAME") return -1;
        return Array.from({ length: window.length }, (_, i) => window[i]).indexOf(element.contentWindow);
      })()`);
      if (index === -1) return frame;
      if (typeof index !== "number" || !frame.frames[index]) {
        throw new Error("The focused preview frame is unavailable.");
      }
      frame = frame.frames[index]!;
    }
  };

  const dispatch = async (event: Electron.KeyboardInputEvent, checkCurrent: () => void) => {
    checkCurrent();
    const packet = { ...event, skipIfUnhandled: true };
    contents.setIgnoreMenuShortcuts(true);
    // Chromium suppresses the char packet when keydown is canceled. The
    // following keyup receipt confirms the whole native sequence was handled.
    if (event.type === "char") {
      contents.sendInputEvent(packet);
      return false;
    }
    const frame = await focusedFrame();
    const receipt = `__t3KeyboardReceipt${++sequence}`;
    const type = event.type === "keyUp" ? "keyup" : "keydown";
    await frame.executeJavaScript(`(() => {
      const name = ${JSON.stringify(receipt)};
      const type = ${JSON.stringify(type)};
      let finish;
      const promise = new Promise(resolve => { finish = resolve; });
      let observed = false;
      let received;
      const count = performance.eventCounts.get(type) ?? 0;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => done({ prevented: received.defaultPrevented });
      const listener = event => {
        if (!event.isTrusted) return;
        observed = true;
        received = event;
        // A task runs after every page listener and the default edit. A
        // microtask can run between listeners, before preventDefault.
        channel.port2.postMessage(null);
      };
      const pagehide = () => done(observed ? { prevented: false } : null);
      const timer = setTimeout(() => done(null), 5000);
      const check = setInterval(() => {
        // Trusted event counts also confirm delivery when page code hides a
        // key with stopImmediatePropagation before our listener sees it.
        if (!observed && (performance.eventCounts.get(type) ?? 0) > count) done({ prevented: false });
      }, 16);
      const done = result => {
        clearTimeout(timer);
        clearInterval(check);
        channel.port1.close();
        channel.port2.close();
        removeEventListener(type, listener, true);
        removeEventListener("pagehide", pagehide, true);
        finish(result);
      };
      addEventListener(type, listener, true);
      addEventListener("pagehide", pagehide, true);
      globalThis[name] = { promise, dispose: () => done(null) };
    })()`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // CDP's root Input commands can target the embedder's focused renderer.
      // Native packets address this guest widget; skipIfUnhandled also keeps
      // keys such as Enter from falling back to the desktop composer.
      checkCurrent();
      contents.sendInputEvent(packet);
      const result: unknown = await Promise.race([
        frame.executeJavaScript(`globalThis[${JSON.stringify(receipt)}]?.promise`),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("The preview page did not receive the keyboard event.")),
            5000,
          );
        }),
      ]);
      if (typeof result !== "object" || result === null || !("prevented" in result)) {
        throw new Error("The preview page did not receive the keyboard event.");
      }
      return result.prevented === true;
    } finally {
      clearTimeout(timeout);
      if (!frame.detached) {
        void frame
          .executeJavaScript(
            `globalThis[${JSON.stringify(receipt)}]?.dispose(); delete globalThis[${JSON.stringify(receipt)}]`,
          )
          .catch(() => {});
      }
    }
  };

  const press = async (params: Record<string, unknown>, checkCurrent: () => void) => {
    const type = params["type"];
    const key = params["key"];
    if (
      (type !== "keyDown" && type !== "rawKeyDown" && type !== "keyUp" && type !== "char") ||
      typeof key !== "string"
    ) {
      throw new Error("Invalid preview keyboard event.");
    }
    const mask = typeof params["modifiers"] === "number" ? params["modifiers"] : 0;
    const target = await focusedFrame();
    if (target.processId !== contents.mainFrame.processId) {
      // A cross-site frame has its own renderer session. Its Input commands
      // bypass the root target's embedder-focus lookup.
      const sessions: Array<string> = [];
      let sessionId: string | undefined;
      let contextId: number | undefined;
      try {
        while (true) {
          const evaluated = (await debuggee.sendCommand(
            "Runtime.evaluate",
            {
              expression: `(() => {
              let element = document.activeElement;
              while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
              return element?.tagName === "IFRAME" || element?.tagName === "FRAME" ? element : null;
            })()`,
              ...(contextId === undefined ? {} : { contextId }),
            },
            sessionId,
          )) as { result: { objectId?: string; subtype?: string } };
          if (evaluated.result.subtype === "null") break;
          const objectId = evaluated.result.objectId;
          if (!objectId) throw new Error("The focused preview frame is unavailable.");
          let frameId: string | undefined;
          try {
            const described = (await debuggee.sendCommand(
              "DOM.describeNode",
              { objectId },
              sessionId,
            )) as { node: { frameId?: string } };
            frameId = described.node.frameId;
          } finally {
            await debuggee
              .sendCommand("Runtime.releaseObject", { objectId }, sessionId)
              .catch(() => {});
          }
          if (!frameId) throw new Error("The focused preview frame is unavailable.");
          const targets = (await debuggee.sendCommand("Target.getTargets")) as {
            targetInfos: ReadonlyArray<{ targetId: string; type: string }>;
          };
          if (
            targets.targetInfos.some(
              (target) => target.type === "iframe" && target.targetId === frameId,
            )
          ) {
            const attached = (await debuggee.sendCommand("Target.attachToTarget", {
              targetId: frameId,
              flatten: true,
            })) as { sessionId: string };
            sessionId = attached.sessionId;
            sessions.push(sessionId);
            contextId = undefined;
          } else {
            const world = (await debuggee.sendCommand(
              "Page.createIsolatedWorld",
              { frameId, worldName: "t3-preview-keyboard" },
              sessionId,
            )) as { executionContextId: number };
            contextId = world.executionContextId;
          }
        }
        if (!sessionId) throw new Error("The focused preview frame is unavailable.");
        await debuggee.sendCommand(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          sessionId,
        );
        checkCurrent();
        await debuggee.sendCommand("Input.dispatchKeyEvent", params, sessionId);
      } finally {
        if (sessionId)
          await debuggee
            .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId)
            .catch(() => {});
        for (const id of sessions)
          await debuggee.sendCommand("Target.detachFromTarget", { sessionId: id }).catch(() => {});
      }
      return;
    }
    const modifiers: NonNullable<Electron.KeyboardInputEvent["modifiers"]> = [];
    for (const [bit, modifier] of [
      [1, "alt"],
      [2, "control"],
      [4, "meta"],
      [8, "shift"],
    ] as const) {
      if (mask & bit) modifiers.push(modifier);
    }
    if (params["isKeypad"] === true) modifiers.push("iskeypad");
    if (params["autoRepeat"] === true) modifiers.push("isautorepeat");
    if (params["location"] === 1) modifiers.push("left");
    if (params["location"] === 2) modifiers.push("right");
    const keyCode = key.startsWith("Arrow") ? key.slice(5) : key === " " ? "Space" : key;
    const prevented = await dispatch(
      {
        type: type === "rawKeyDown" ? "keyDown" : type,
        keyCode,
        modifiers,
      },
      checkCurrent,
    );
    if (type === "keyUp" || type === "char" || prevented) return;
    const commands = params["commands"];
    if (Array.isArray(commands) && commands.length > 0) {
      const frame = await focusedFrame();
      const clipboardData: Array<{ type: string; data: string }> = [];
      if (commands.includes("paste")) {
        for (const item of await readClipboard()) {
          for (const type of item.types) {
            if (type.startsWith("electron ")) continue;
            const blob = await item.getType(type);
            if (!("arrayBuffer" in blob)) continue;
            clipboardData.push({
              type,
              data: type.startsWith("text/")
                ? await blob.text()
                : Buffer.from(await blob.arrayBuffer()).toString("base64"),
            });
          }
        }
      }
      checkCurrent();
      await frame.executeJavaScript(
        `(() => {
        for (const command of ${JSON.stringify(commands)}) {
          let element = document.activeElement;
          while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
          if (command === "paste") {
            const transfer = new DataTransfer();
            for (const { type, data } of ${JSON.stringify(clipboardData)}) {
              if (type === "text/html") {
                const container = document.createElement("div");
                container.setHTML(data);
                transfer.setData(type, container.innerHTML);
              } else if (type.startsWith("text/")) transfer.setData(type, data);
              else transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], "clipboard", { type }));
            }
            if (!element?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }))) continue;
            const text = transfer.getData("text/plain");
            if (!element.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", data: text, dataTransfer: transfer, bubbles: true, cancelable: true, composed: true }))) continue;
            const html = element.isContentEditable ? transfer.getData("text/html") : "";
            document.execCommand(html ? "insertHTML" : "insertText", false, html || text);
          } else if (command.startsWith("moveTo")) {
            document.getSelection()?.modify(
              command.endsWith("AndModifySelection") ? "extend" : "move",
              command.includes("Beginning") ? "backward" : command.includes("Left") ? "left" : command.includes("Right") ? "right" : "forward",
              command.includes("Document") ? "documentboundary" : "lineboundary",
            );
          } else if (command === "deleteToBeginningOfLine") {
            const selection = document.getSelection();
            if (!element?.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteSoftLineBackward", bubbles: true, cancelable: true, composed: true }))) continue;
            const collapsed = typeof element?.selectionStart === "number" ? element.selectionStart === element.selectionEnd : selection?.isCollapsed;
            if (collapsed) selection?.modify("extend", "backward", "lineboundary");
            document.execCommand("delete");
          } else {
            const inputType = command === "undo" ? "historyUndo" : command === "redo" ? "historyRedo" : null;
            if (inputType && !element?.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true, composed: true }))) continue;
            document.execCommand(command);
          }
        }
      })()`,
        true,
      );
    }
    const text = params["text"];
    if (type === "keyDown" && typeof text === "string" && text.length > 0) {
      await dispatch({ type: "char", keyCode: text, modifiers }, checkCurrent);
    }
  };

  return {
    isDispatching: () => pending > 0,
    cancel: () => {
      generation++;
    },
    send: (method: string, params: Record<string, unknown>) => {
      pending++;
      const current = generation;
      const checkCurrent = () => {
        if (current !== generation)
          throw new Error("The preview keyboard connection was released.");
      };
      const result = tail.then(async () => {
        checkCurrent();
        if (method === "Input.insertText") {
          const text = params["text"];
          if (typeof text !== "string") throw new Error("Invalid preview text.");
          if (text.length > 0) {
            const frame = await focusedFrame();
            checkCurrent();
            const inserted: unknown = await frame.executeJavaScript(`(() => {
              let element = document.activeElement;
              while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
              const text = ${JSON.stringify(text)};
              const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
              const textControl = element?.tagName === "TEXTAREA" || (element?.tagName === "INPUT" && !nonText.includes(element.type));
              if (!(textControl || element?.isContentEditable) || element.disabled || element.readOnly) return false;
              if (!element?.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true, composed: true }))) return true;
              return document.execCommand("insertText", false, text);
            })()`);
            if (inserted !== true) throw new Error("The preview page did not accept the text.");
          }
        } else {
          await press(params, checkCurrent);
        }
        return {};
      });
      tail = result.catch(() => {});
      return result.finally(() => {
        pending--;
      });
    },
  };
}
