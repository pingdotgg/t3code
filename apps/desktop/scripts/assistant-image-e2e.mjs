import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { chromium } from "playwright-core";

import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const repoRoot = NodePath.resolve(desktopDir, "..", "..");
const mainJs = NodePath.join(desktopDir, "dist-electron", "main.cjs");
const serverBundle = NodePath.join(repoRoot, "apps", "server", "dist", "bin.mjs");
const sourcePng = NodePath.join(repoRoot, "assets", "dev", "blueprint-universal-1024.png");
const testHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-assistant-image-e2e-"));
const attachmentId = "thread-inline-image-11111111-1111-4111-8111-111111111111";
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone E2E runner has no Effect runtime.
const hostPlatform = NodeOS.platform();

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a desktop test port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function seedGeneratedImageProjection() {
  const userdataDir = NodePath.join(testHome, "userdata");
  const attachmentsDir = NodePath.join(userdataDir, "attachments");
  const database = new NodeSqlite.DatabaseSync(NodePath.join(userdataDir, "state.sqlite"));
  const modelSelection = JSON.stringify({ instanceId: "codex", model: "gpt-5.4" });
  const attachment = JSON.stringify([
    {
      type: "image",
      id: attachmentId,
      name: "generated-blueprint.png",
      mimeType: "image/png",
      sizeBytes: NodeFS.statSync(sourcePng).size,
    },
  ]);
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        "project-inline-image",
        "Inline image verification",
        repoRoot,
        modelSelection,
        "2026-08-11T06:55:00.000Z",
        "2026-08-11T06:55:02.000Z",
      );
    database
      .prepare(
        `INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_user_message_at, created_at, updated_at, settled_at
        ) VALUES (?, ?, ?, ?, 'full-access', 'default', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "thread-inline-image",
        "project-inline-image",
        "Generated PNG renders inline",
        modelSelection,
        "worktree",
        repoRoot,
        "2026-08-11T06:55:00.000Z",
        "2026-08-11T06:55:00.000Z",
        "2026-08-11T06:55:02.000Z",
        "2026-08-11T06:55:02.000Z",
      );
    database
      .prepare(
        `INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
          attachments_json
        ) VALUES (?, ?, ?, 'assistant', ?, 0, ?, ?, ?)`,
      )
      .run(
        "message-inline-image-assistant",
        "thread-inline-image",
        "turn-inline-image",
        "",
        "2026-08-11T06:55:02.000Z",
        "2026-08-11T06:55:02.000Z",
        attachment,
      );
    database
      .prepare(
        `INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at,
          attachments_json
        ) VALUES (?, ?, ?, 'assistant', ?, 0, ?, ?, '[]')`,
      )
      .run(
        "message-inline-image-final",
        "thread-inline-image",
        "turn-inline-image",
        "Here is the generated PNG.",
        "2026-08-11T06:55:03.000Z",
        "2026-08-11T06:55:03.000Z",
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  NodeFS.mkdirSync(attachmentsDir, { recursive: true });
  NodeFS.copyFileSync(sourcePng, NodePath.join(attachmentsDir, `${attachmentId}.png`));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function launchDesktop(backendPort, debugPort) {
  const launchCommand = resolveElectronLaunchCommand([
    `--remote-debugging-port=${debugPort}`,
    mainJs,
  ]);
  const childEnv = {
    ...process.env,
    APPDATA: NodePath.join(testHome, "appdata"),
    ELECTRON_ENABLE_LOGGING: "1",
    T3CODE_DESKTOP_APP_USER_MODEL_ID: `com.t3tools.t3code.e2e.${NodePath.basename(testHome)}`,
    T3CODE_HOME: testHome,
    T3CODE_PORT: String(backendPort),
    VITE_DEV_SERVER_URL: "",
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = NodeChildProcess.spawn(launchCommand.electronPath, launchCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const appendOutput = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  return { child, getOutput: () => output };
}

async function connectToDesktop(run, debugPort) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null) {
      throw new Error(
        `Desktop exited before CDP became available (${run.child.exitCode}).\n${run.getOutput()}`,
      );
    }
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const context = browser.contexts()[0];
      if (context) return { browser, context };
      await browser.close();
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out connecting to desktop CDP: ${String(lastError)}\n${run.getOutput()}`);
}

async function waitForAppWindow(context) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => !candidate.url().startsWith("devtools://"));
    if (page) {
      await page.locator("body").waitFor({ state: "visible", timeout: 45_000 });
      return page;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the T3 Code desktop window.");
}

async function stopDesktop(run, browser) {
  await browser?.close().catch(() => undefined);
  if (run.child.exitCode !== null) return;

  if (hostPlatform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(run.child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    run.child.kill("SIGTERM");
  }

  const exited = new Promise((resolve) => run.child.once("exit", resolve));
  await Promise.race([exited, delay(5_000)]);
  if (run.child.exitCode === null) run.child.kill("SIGKILL");
}

if (!NodeFS.existsSync(mainJs) || !NodeFS.existsSync(serverBundle)) {
  throw new Error("Build the desktop and server bundles before running the assistant image E2E.");
}

let run;
let browser;
try {
  let backendPort = await reservePort();
  let debugPort = await reservePort();
  run = launchDesktop(backendPort, debugPort);
  ({ browser } = await connectToDesktop(run, debugPort));
  await waitForAppWindow(browser.contexts()[0]);
  await stopDesktop(run, browser);
  run = undefined;
  browser = undefined;

  seedGeneratedImageProjection();
  backendPort = await reservePort();
  debugPort = await reservePort();
  run = launchDesktop(backendPort, debugPort);
  let context;
  ({ browser, context } = await connectToDesktop(run, debugPort));
  const window = await waitForAppWindow(context);
  await window
    .getByTestId("sidebar-row-card")
    .filter({ hasText: "Generated PNG renders inline" })
    .click();
  const image = window.getByRole("img", { name: "generated-blueprint.png" });
  await image.waitFor({ state: "visible", timeout: 30_000 });
  const imageState = await image.evaluate((element) => ({
    src: element.currentSrc || element.src,
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
  }));
  if (
    !imageState.src.includes("/api/assets/") ||
    imageState.naturalWidth <= 0 ||
    imageState.naturalHeight <= 0
  ) {
    throw new Error(
      `Assistant image did not render through the asset endpoint: ${JSON.stringify(imageState)}`,
    );
  }
  process.stdout.write(`Assistant image E2E passed: ${JSON.stringify(imageState)}\n`);
} finally {
  if (run) await stopDesktop(run, browser);
  NodeFS.rmSync(testHome, { recursive: true, force: true });
}
