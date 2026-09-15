import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

// Run with Node on Linux. Xvfb and xdotool must be on PATH. All windows and
// native keyboard events belong to the display created here, not the desktop.
if (!process.argv.includes("--focus-test-child")) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-focus-"));
  const display = NodeChildProcess.spawn(
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
    {
      stdio: ["ignore", "ignore", "inherit", "pipe"],
    },
  );
  let child;
  const deadlineAbort = new AbortController();
  const deadline = setTimeout(() => {
    deadlineAbort.abort(new Error("Native focus test exceeded 30 seconds"));
    child?.kill();
    display.kill();
  }, 30_000);
  try {
    const [number] = await NodeEvents.once(display.stdio[3], "data", {
      signal: deadlineAbort.signal,
    });
    const electron = NodeModule.createRequire(import.meta.url)("electron");
    const childEnv = { ...process.env, DISPLAY: `:${number.toString().trim()}` };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    child = NodeChildProcess.spawn(
      electron,
      [
        "--no-sandbox",
        "--ozone-platform=x11",
        NodeURL.fileURLToPath(import.meta.url),
        "--focus-test-child",
        directory,
      ],
      {
        env: childEnv,
        stdio: "inherit",
      },
    );
    const [code] = await NodeEvents.once(child, "exit", { signal: deadlineAbort.signal });
    NodeAssert.equal(code, 0, "Electron focus test failed");
  } finally {
    clearTimeout(deadline);
    if (child?.exitCode === null) child.kill();
    display.kill();
    if (display.exitCode === null && display.signalCode === null)
      await NodeEvents.once(display, "exit");
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, session } = await import("electron");
  const { BrowserViewHost } = await import("../src/preview/BrowserViewHost.ts");
  const directory = process.argv.at(-1);
  app.setPath("userData", NodePath.join(directory, "profile"));
  app.whenReady().then(async () => {
    let window;
    let host;
    try {
      const preload = NodePath.join(directory, "preload.cjs");
      await NodeFSP.writeFile(preload, "");
      const pagePath = NodePath.join(directory, "page.html");
      await NodeFSP.writeFile(
        pagePath,
        '<input id="target" style="margin:20px;width:200px;height:50px"><script>window.clicks=0;target.addEventListener("click",e=>{if(e.isTrusted)clicks++});target.addEventListener("input",()=>console.log("input-receipt"));</script>',
      );
      const editorPath = NodePath.join(directory, "editor.html");
      await NodeFSP.writeFile(
        editorPath,
        '<textarea id="editor" style="width:400px;height:200px"></textarea><script>editor.addEventListener("input",()=>console.log("input-receipt"));</script>',
      );
      window = new BrowserWindow({ width: 1000, height: 700 });
      await window.loadFile(editorPath);
      host = new BrowserViewHost(window, "linux");
      const guests = [];
      for (const tabId of ["first", "second"]) {
        const contents = host.create(tabId, session.fromPartition("focus-test"), preload, 1);
        host.layout(tabId, {
          rendering: tabId === "first",
          viewport: { width: 400, height: 400 },
          clip: tabId === "first" ? { x: 500, y: 100, width: 400, height: 400 } : null,
          content: { x: 0, y: 0, scale: 1 },
        });
        await contents.loadFile(pagePath);
        contents.debugger.attach("1.3");
        guests.push(contents);
      }
      const inputReceipt = (contents) =>
        new Promise((resolve) => {
          const onMessage = (event) => {
            if (event.message !== "input-receipt") return;
            contents.removeListener("console-message", onMessage);
            resolve();
          };
          contents.on("console-message", onMessage);
        });
      const click = async (contents) => {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type,
            x: 100,
            y: 45,
            button: "left",
            clickCount: 1,
          });
        }
      };
      const focusEditor = async () => {
        window.show();
        const bounds = window.getContentBounds();
        const point = await window.webContents.executeJavaScript(
          "({x: editor.offsetLeft + 20, y: editor.offsetTop + 20})",
        );
        // A programmatic focus would pass even if a native page covered the chat.
        await exec("xdotool", [
          "mousemove",
          String(bounds.x + point.x),
          String(bounds.y + point.y),
          "click",
          "1",
        ]);
        NodeAssert.equal(
          await window.webContents.executeJavaScript(
            "document.hasFocus() && document.activeElement === editor",
          ),
          true,
        );
        await window.webContents.executeJavaScript(
          "editor.setSelectionRange(editor.value.length, editor.value.length)",
        );
      };
      await focusEditor();
      let text = "x".repeat(200);
      const typed = exec("xdotool", ["type", "--clearmodifiers", "--delay", "10", text]);
      for (let index = 0; index < 200; index++) await click(guests[index % 2]);
      await typed;
      NodeAssert.equal(await window.webContents.executeJavaScript("editor.value"), text);
      for (const guest of guests) {
        NodeAssert.deepEqual(await guest.executeJavaScript("({text:target.value,clicks})"), {
          text: "",
          clicks: 100,
        });
      }
      const navigationText = "n".repeat(50);
      const typingDuringNavigation = exec("xdotool", [
        "type",
        "--clearmodifiers",
        "--delay",
        "10",
        navigationText,
      ]);
      for (let index = 0; index < 8; index++) await guests[index % 2].loadFile(pagePath);
      await typingDuringNavigation;
      text += navigationText;
      NodeAssert.equal(await window.webContents.executeJavaScript("editor.value"), text);
      for (const guest of guests)
        NodeAssert.equal(await guest.executeJavaScript("target.value"), "");
      for (let index = 0; index < 10; index++) {
        host.input("first", {
          type: "mouseDown",
          x: 100,
          y: 45,
          button: "left",
          clickCount: 1,
          modifiers: [],
        });
        guests[0].sendInputEvent({
          type: "mouseUp",
          x: 100,
          y: 45,
          button: "left",
          clickCount: 1,
          modifiers: [],
        });
        const humanReceipt = inputReceipt(guests[0]);
        await exec("xdotool", ["type", "--clearmodifiers", "h"]);
        await humanReceipt;
        await focusEditor();
        NodeAssert.equal(host.isInteractive("first"), false);
        await click(guests[1]);
        const editorReceipt = inputReceipt(window.webContents);
        await exec("xdotool", ["type", "--clearmodifiers", "y"]);
        await editorReceipt;
      }
      NodeAssert.equal(await guests[0].executeJavaScript("target.value"), "h".repeat(10));
      NodeAssert.equal(await guests[1].executeJavaScript("target.value"), "");
      NodeAssert.equal(
        await window.webContents.executeJavaScript("editor.value"),
        text + "y".repeat(10),
      );
      const otherWindow = new BrowserWindow({ width: 600, height: 400 });
      try {
        await otherWindow.loadFile(editorPath);
        otherWindow.show();
        otherWindow.webContents.focus();
        await otherWindow.webContents.executeJavaScript("editor.focus()");
        await click(guests[1]);
        const receipt = inputReceipt(otherWindow.webContents);
        await exec("xdotool", ["type", "--clearmodifiers", "z"]);
        await receipt;
        NodeAssert.equal(await otherWindow.webContents.executeJavaScript("editor.value"), "z");
        NodeAssert.equal(otherWindow.isFocused(), true);
      } finally {
        otherWindow.destroy();
      }
      host.input("first", null);
      window.destroy();
      host.destroy(); // Closing the owner and repeated cleanup must both be safe.
      console.log(
        "Browser focus passed: 200 concurrent native keys, typing during navigation, two automated tabs, 10 native interaction round trips, external window focus, owner cleanup.",
      );
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      host?.destroy();
      window?.destroy();
      app.exit(process.exitCode ?? 0);
    }
  });
}
