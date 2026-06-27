const { app, BrowserWindow, WebContentsView } = require("electron");

const fail = (message) => {
  throw new Error(`Native preview smoke test failed: ${message}`);
};

const waitForLoad = (webContents) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("page load timed out")), 10_000);
    webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      resolve();
    });
    webContents.once("did-fail-load", (_event, code, description) => {
      clearTimeout(timeout);
      reject(new Error(`page load failed (${code} ${description})`));
    });
  });

const closeView = (window, view) => {
  view.setVisible(false);
  window.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
};

const firstPixelRgb = (image) => {
  const bitmap = image.toBitmap();
  return { red: bitmap[2], green: bitmap[1], blue: bitmap[0] };
};

const isOrange = ({ red, green, blue }) => red > 200 && green >= 70 && green <= 170 && blue < 100;

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      x: 0,
      y: 0,
      opacity: 0,
      skipTaskbar: true,
    });
    window.setIgnoreMouseEvents(true);
    window.showInactive();
    const captureWindow = new BrowserWindow({
      show: false,
      width: 450,
      height: 600,
      x: 0,
      y: 0,
      opacity: 0,
      transparent: true,
      skipTaskbar: true,
      focusable: false,
    });
    captureWindow.setIgnoreMouseEvents(true);
    captureWindow.showInactive();
    await window.loadURL(
      "data:text/html,<body style='margin:0;background:%23111827'><div style='position:fixed;left:20px;top:20px;width:120px;height:60px;background:%23f97316'></div></body>",
    );
    const visibleView = new WebContentsView({
      webPreferences: { backgroundThrottling: false },
    });
    const hiddenView = new WebContentsView({
      webPreferences: { backgroundThrottling: false },
    });
    window.contentView.addChildView(visibleView);
    captureWindow.contentView.addChildView(hiddenView);
    visibleView.setBounds({ x: 0, y: 0, width: 450, height: 600 });
    hiddenView.setBounds({ x: 0, y: 0, width: 450, height: 600 });
    visibleView.setVisible(true);
    hiddenView.setVisible(true);
    visibleView.webContents.setBackgroundThrottling(false);
    hiddenView.webContents.setBackgroundThrottling(false);

    const visibleLoaded = waitForLoad(visibleView.webContents);
    const hiddenLoaded = waitForLoad(hiddenView.webContents);
    await visibleView.webContents.loadURL(
      "data:text/html,<body style='margin:0;background:%232563eb'><button id='button' style='position:fixed;left:10px;top:10px;width:120px;height:60px' onclick='window.clicks=(window.clicks||0)+1'>Click</button></body>",
    );
    await hiddenView.webContents.loadURL(
      "data:text/html,<title>Hidden native tab</title><main id='state'>initial</main>",
    );
    await Promise.all([visibleLoaded, hiddenLoaded]);

    visibleView.webContents.sendInputEvent({ type: "mouseMove", x: 40, y: 40 });
    visibleView.webContents.sendInputEvent({
      type: "mouseDown",
      x: 40,
      y: 40,
      button: "left",
      clickCount: 1,
    });
    visibleView.webContents.sendInputEvent({
      type: "mouseUp",
      x: 40,
      y: 40,
      button: "left",
      clickCount: 1,
    });
    const clickCount = await visibleView.webContents.executeJavaScript("window.clicks || 0", true);
    if (clickCount !== 1) fail(`visible native input produced ${clickCount} clicks`);
    console.log("Native preview smoke: visible input passed.");

    hiddenView.webContents.debugger.attach("1.3");
    await Promise.all(
      ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable", "Page.enable"].map(
        (method) => hiddenView.webContents.debugger.sendCommand(method),
      ),
    );
    console.log("Native preview smoke: control domains passed.");
    await hiddenView.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: "document.querySelector('#state').textContent='automated while hidden'",
      awaitPromise: true,
      returnByValue: true,
    });
    const hiddenText = await hiddenView.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: "document.querySelector('#state').textContent",
      returnByValue: true,
    });
    if (hiddenText.result?.value !== "automated while hidden") {
      fail("hidden CDP evaluation did not persist");
    }
    console.log("Native preview smoke: hidden automation passed.");

    const screenshot = await hiddenView.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    if (
      typeof screenshot.data !== "string" ||
      Buffer.from(screenshot.data, "base64").byteLength === 0
    ) {
      fail("hidden snapshot was empty");
    }
    console.log("Native preview smoke: hidden snapshot passed.");

    for (const color of ["rgb(37, 99, 235)", "rgb(22, 163, 74)", "rgb(220, 38, 38)"]) {
      await hiddenView.webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: `document.body.style.background=${JSON.stringify(color)}`,
        returnByValue: true,
      });
      const frame = await hiddenView.webContents.debugger.sendCommand("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      if (typeof frame.data !== "string" || frame.data.length === 0) {
        fail("hidden recording frame was empty");
      }
      console.log(`Native preview smoke: hidden recording frame ${color} passed.`);
    }

    window.contentView.removeChildView(visibleView);
    captureWindow.contentView.addChildView(visibleView);
    visibleView.setBounds({ x: 0, y: 0, width: 450, height: 600 });
    const revealedPixel = firstPixelRgb(
      await window.capturePage({ x: 25, y: 25, width: 1, height: 1 }),
    );
    if (!isOrange(revealedPixel)) {
      fail(`app overlay was not revealed after native handoff (${JSON.stringify(revealedPixel)})`);
    }
    const reparentedCapture = await visibleView.webContents.capturePage();
    if (reparentedCapture.isEmpty()) fail("reparented native view capture was empty");
    console.log("Native preview smoke: app overlay handoff passed.");

    closeView(captureWindow, hiddenView);
    closeView(captureWindow, visibleView);
    captureWindow.destroy();
    window.destroy();
    console.log("Native preview smoke test passed.");
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
