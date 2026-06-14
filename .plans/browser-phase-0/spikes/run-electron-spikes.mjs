import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, rm } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const requireDesktop = createRequire(join(repositoryRoot, "apps/desktop/package.json"));
const requireWeb = createRequire(join(repositoryRoot, "apps/web/package.json"));
const electronBinary = requireDesktop("electron");
const { chromium } = requireWeb("playwright");
const playwrightPackage = requireWeb.resolve("playwright/package.json");
const playwrightVersion = JSON.parse(await readFile(playwrightPackage, "utf8")).version;
const playwrightCoreBundle = resolve(
  dirname(playwrightPackage),
  `../../../playwright-core@${playwrightVersion}/node_modules/playwright-core/lib/coreBundle.js`,
);

async function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function launchHost({ mode, port, output }) {
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const command = {
    electronPath: electronBinary,
    args: [
      join(here, "electron-webview-bootstrap.cjs"),
      `--mode=${mode}`,
      ...(port ? [`--port=${port}`] : []),
      ...(output ? [`--output=${output}`] : []),
      `--playwright-core-bundle=${playwrightCoreBundle}`,
    ],
  };
  const child = spawn(
    command.electronPath,
    command.args,
    { cwd: repositoryRoot, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForResult(child, output, timeoutMs = 20_000) {
  const resultPath = join(output, "result.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  child.kill("SIGTERM");
  throw new Error(`Timed out waiting for ${resultPath}`);
}

async function runAutomation(hostMode = "automation") {
  const port = await reservePort();
  const output = join(repositoryRoot, ".plans/browser-phase-0/results", hostMode);
  await rm(output, { recursive: true, force: true });
  const child = launchHost({ mode: hostMode, port, output });
  const hostResult = await waitForResult(child, output);
  let browser;
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    let lastError;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        browser = await chromium.connectOverCDP(endpoint);
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
    if (!browser) throw lastError;
    const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
    const pages = browser.contexts().flatMap((context) => context.pages());
    const pageMetadata = await Promise.all(
      pages.map(async (page) => ({ url: page.url(), title: await page.title().catch(() => "") })),
    );
    const guestPage = pages.find((page, index) => pageMetadata[index]?.title === "Phase0 Guest");
    if (!guestPage) {
      const guestTarget = targets.find((target) => target.title === "Phase0 Guest");
      let directTargetAttachment;
      if (guestTarget?.webSocketDebuggerUrl) {
        try {
          const directBrowser = await chromium.connectOverCDP(guestTarget.webSocketDebuggerUrl);
          const directPages = directBrowser.contexts().flatMap((context) => context.pages());
          directTargetAttachment = {
            success: true,
            pages: await Promise.all(
              directPages.map(async (page) => ({ url: page.url(), title: await page.title().catch(() => "") })),
            ),
          };
          await directBrowser.close();
        } catch (error) {
          directTargetAttachment = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return {
        hostResult,
        targets: targets.map(({ id, title, type, url }) => ({ id, title, type, url })),
        pageMetadata,
        directTargetAttachment,
        success: false,
        reason: "Guest webview was not exposed as a Playwright Page",
      };
    }
    const button = guestPage.getByRole("button", { name: "Increment count" });
    await button.click();
    const countAfterClick = await guestPage.locator("#count").textContent();
    const input = guestPage.getByRole("textbox", { name: "Message" });
    await input.fill("semantic locator attached");
    const inputValue = await input.inputValue();
    const expectedCount = String(Number(hostResult.semanticProbe?.state?.count ?? "0") + 1);
    return {
      hostResult,
      pageMetadata,
      success: countAfterClick === expectedCount && inputValue === "semantic locator attached",
      countAfterClick,
      inputValue,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill("SIGTERM");
  }
}

async function runManagedMode(mode) {
  const output = join(repositoryRoot, ".plans/browser-phase-0/results", mode);
  await rm(output, { recursive: true, force: true });
  const child = launchHost({ mode, output });
  return waitForResult(child, output, mode === "recording" ? 30_000 : 20_000);
}

const requestedMode = process.argv[2] ?? "all";
const result = {};
if (requestedMode === "all" || requestedMode === "automation") result.automation = await runAutomation();
if (requestedMode === "all" || requestedMode === "view-automation") {
  result.viewAutomation = await runAutomation("view-automation");
}
if (requestedMode === "all" || requestedMode === "hidden") result.hidden = await runManagedMode("hidden");
if (requestedMode === "all" || requestedMode === "recording") result.recording = await runManagedMode("recording");
if (requestedMode === "all" || requestedMode === "offscreen-recording") {
  result.offscreenRecording = await runManagedMode("offscreen-recording");
}
if (requestedMode === "all" || requestedMode === "covered-recording") {
  result.coveredRecording = await runManagedMode("covered-recording");
}
if (requestedMode === "all" || requestedMode === "media-recorder") {
  result.mediaRecorder = await runManagedMode("media-recorder");
}
if (requestedMode === "all" || requestedMode === "latency") result.latency = await runManagedMode("latency");
if (requestedMode === "all" || requestedMode === "injected-runtime") {
  result.injectedRuntime = await runManagedMode("injected-runtime");
}
if (requestedMode === "all" || requestedMode === "renderer-reload") {
  result.rendererReload = await runManagedMode("renderer-reload");
}
if (requestedMode === "all" || requestedMode === "input-origin") {
  result.inputOrigin = await runManagedMode("input-origin");
}
if (requestedMode === "all" || requestedMode === "recording-endurance") {
  result.recordingEndurance = await runManagedMode("recording-endurance");
}
if (requestedMode === "all" || requestedMode === "view-hidden") {
  result.viewHidden = await runManagedMode("view-hidden");
}
if (requestedMode === "all" || requestedMode === "view-detached") {
  result.viewDetached = await runManagedMode("view-detached");
}
if (requestedMode === "all" || requestedMode === "view-recording") {
  result.viewRecording = await runManagedMode("view-recording");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
