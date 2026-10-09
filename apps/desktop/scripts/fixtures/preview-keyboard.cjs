const { app, BrowserWindow, ClipboardItem, clipboard } = require("electron");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const Effect = require("effect/Effect");
const Stream = require("effect/Stream");
const { chromium } = require("playwright-core");
const { wsServer } = require("playwright-core/lib/utilsBundle");
const ServerBrowserPage = require("../../../server/src/preview/ServerBrowserPage.ts");
const DesktopBrowserHost = require("../../src/preview/DesktopBrowserHost.ts");

app.setPath("userData", process.argv[2]);
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    request.url === "/child"
      ? '<input id="name">'
      : `
    <input id="name" aria-label="Name"><form action="/submitted"><input id="submit" name="value"></form><textarea id="area"></textarea>
    <div id="edit" contenteditable></div><div id="shadow"></div>
    <iframe src="http://127.0.0.1:${server.address().port}/child"></iframe>
    <iframe src="http://localhost:${server.address().port}/child"></iframe>
    <script>
      document.getElementById("shadow").attachShadow({mode:"open"}).innerHTML = '<input id="inner">';
      window.keys = [];
      addEventListener("keydown", event => keys.push({ key: event.key, trusted: event.isTrusted }));
    </script>`,
  );
});

const run = async () => {
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  await app.whenReady();
  const originalClipboard = await Promise.all(
    (await clipboard.read()).map(
      async (item) =>
        new ClipboardItem(
          Object.fromEntries(
            await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
          ),
        ),
    ),
  );
  try {
    const win = new BrowserWindow({
      width: 800,
      height: 500,
      webPreferences: { webviewTag: true, backgroundThrottling: false },
    });
    const attached = once(win.webContents, "did-attach-webview");
    await win.loadURL(
      `data:text/html,${encodeURIComponent(`<textarea id="draft">unfinished draft</textarea><webview style="width:600px;height:300px" src="http://127.0.0.1:${server.address().port}/"></webview><script>window.hostKeys=[];addEventListener('keydown',e=>hostKeys.push(e.key));</script>`)}`,
    );
    const [, guest] = await attached;
    if (guest.isLoading()) await once(guest, "did-stop-loading");
    guest.debugger.attach("1.3");
    await guest.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const host = await Effect.runPromise(DesktopBrowserHost.make);
    const key = { threadId: "regression", tabId: "guest" };
    let socket;
    Effect.runFork(
      host.events.pipe(
        Stream.runForEach((line) =>
          Effect.sync(() => {
            const event = JSON.parse(new TextDecoder().decode(line));
            if (event.type === "cdp") socket?.send(event.message);
          }),
        ),
      ),
    );
    host.attach(key, { webContents: guest, debugger: guest.debugger });
    const sockets = new wsServer({ server });
    sockets.on("connection", (connection) => {
      socket = connection;
      connection.on("message", (message) =>
        Effect.runPromise(
          host.handleCommandLine(
            JSON.stringify({ type: "cdp", ...key, message: message.toString() }),
          ),
        ),
      );
    });
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${server.address().port}`);
    const page = browser.contexts()[0].pages()[0];
    const cdp = await page.context().newCDPSession(page);
    const send = (method, params = {}) => cdp.send(method, params);
    const press = (key, modifiers = []) => ServerBrowserPage.press(page, { key, modifiers });
    const focus = async (expression, frame = guest.mainFrame) => {
      await frame.executeJavaScript(`${expression}.focus()`);
      win.focus();
      win.webContents.focus();
      await win.webContents.executeJavaScript('document.getElementById("draft").focus()');
    };
    const value = (selector, frame = guest.mainFrame) =>
      frame.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value`);
    const preserved = async () => {
      assert.equal(
        await win.webContents.executeJavaScript('document.getElementById("draft").value'),
        "unfinished draft",
      );
      assert.equal(await win.webContents.executeJavaScript("document.activeElement.id"), "draft");
      assert.deepEqual(await win.webContents.executeJavaScript("hostKeys"), []);
    };
    const results = [];
    for (const hidden of [true, false]) {
      await win.webContents.executeJavaScript(
        `document.querySelector("webview").style.visibility = ${JSON.stringify(hidden ? "hidden" : "visible")}`,
      );
      await focus('document.getElementById("name")');
      await ServerBrowserPage.type(page, { locator: 'role=textbox[name="Name"]', text: "Jason" });
      await press("J");
      await press("o");
      assert.equal(await value("#name"), "JasonJo");
      await press("Meta");
      await press("a", ["Meta"]);
      await press("Delete");
      assert.equal(await value("#name"), "");
      await ServerBrowserPage.type(page, {
        locator: 'role=textbox[name="Name"]',
        text: "replacement",
        clear: true,
      });
      assert.equal(await value("#name"), "replacement");
      await press("Enter");
      await press("a", ["Meta"]);
      await press("Delete");
      await preserved();
      results.push(hidden ? "hidden input and keys" : "visible input and keys");
    }
    await focus('document.getElementById("area")');
    await send("Input.insertText", { text: "textarea" });
    await press("!");
    assert.equal(await value("#area"), "textarea!");
    await focus('document.getElementById("edit")');
    await send("Input.insertText", { text: "editor" });
    await press("x");
    assert.equal(
      await guest.executeJavaScript('document.getElementById("edit").textContent'),
      "editorx",
    );
    await focus('document.getElementById("shadow").shadowRoot.querySelector("input")');
    await send("Input.insertText", { text: "shadow" });
    await press("x");
    assert.equal(
      await guest.executeJavaScript(
        'document.getElementById("shadow").shadowRoot.querySelector("input").value',
      ),
      "shadowx",
    );
    results.push("textarea, contenteditable, and shadow input");
    for (const frame of guest.mainFrame.frames) {
      await focus('document.querySelector("input")', frame);
      await send("Input.insertText", { text: "frame" });
      await press("x");
      assert.equal(await value("input", frame), "framex");
      await preserved();
      results.push(frame.url.includes("localhost") ? "cross-site frame" : "same-site frame");
    }
    await focus('document.getElementById("name")');
    await send("Input.insertText", { text: "history" });
    await press("z", ["Meta"]);
    assert.equal(await value("#name"), "");
    await press("z", ["Meta", "Shift"]);
    assert.equal(await value("#name"), "history");
    await press("a", ["Meta"]);
    await press("c", ["Meta"]);
    assert.equal(await clipboard.readText(), "history");
    await clipboard.writeText("paste");
    await press("v", ["Meta"]);
    assert.equal(await value("#name"), "paste");
    await guest.executeJavaScript(
      'document.getElementById("name").addEventListener("keydown", e => { if(e.key === "q") e.preventDefault(); })',
    );
    await press("q");
    assert.equal(await value("#name"), "paste");
    await guest.executeJavaScript(
      'addEventListener("keyup", e => { if(e.key === "y") e.stopImmediatePropagation(); }, true)',
    );
    await press("y");
    assert.equal(await value("#name"), "pastey");
    await preserved();
    assert.equal(await guest.executeJavaScript("keys.every(key => key.trusted)"), true);
    results.push("editing shortcuts, canceled keys, and trusted events");
    await guest.executeJavaScript("document.body.tabIndex = -1");
    await focus("document.body");
    await assert.rejects(send("Input.insertText", { text: "lost" }), /did not accept/);
    await focus('document.getElementById("name")');
    await send("Input.insertText", { text: " recovered" });
    assert.equal(await value("#name"), "pastey recovered");
    results.push("undeliverable text fails and the queue recovers");
    await focus('document.getElementById("submit")');
    await ServerBrowserPage.type(page, { text: "submitted" });
    const navigated = page.waitForURL(/\/submitted/);
    await press("Enter");
    await navigated;
    await preserved();
    results.push("Enter navigation preserves the host draft");
    console.log(JSON.stringify({ results }));
    await browser.close();
    sockets.close();
    win.destroy();
    server.close();
  } finally {
    await clipboard.write(originalClipboard);
  }
  app.quit();
};
run().catch((error) => {
  console.error(error);
  server.close();
  app.exit(1);
});
