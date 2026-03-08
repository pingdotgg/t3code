import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import { _electron as electron } from "playwright";

import { desktopDir } from "./electron-launcher.mjs";

const repoRoot = path.resolve(desktopDir, "../..");
const artifactDir = path.join(repoRoot, "output", "playwright", "desktop-feedback");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-feedback-"));
const dbPath = path.join(stateDir, "state.sqlite");
const appName = "T3 Code (Alpha)";
const require = createRequire(path.join(desktopDir, "package.json"));
const electronBinaryPath = require("electron");
const userMessageText =
  "I need a printable version of Ransom Notes, plus the print-ready files and a local app for testing.";
const assistantMessageText =
  "The print-ready assets are in place, and the prompt view now reads with much stronger contrast.";
const workCommand = '/bin/zsh -lc "bun run build:desktop"';
const queuedFollowUpText = "Queue this once the current run finishes.";
const previewBusyActionText = "Preview the busy action";
const staticThreadTitle = "Adam feedback static";
const runningThreadTitle = "Adam feedback running";
const markdownImageSvg =
  "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160' viewBox='0 0 240 160'><rect width='240' height='160' rx='16' fill='#142534'/><circle cx='48' cy='44' r='18' fill='#f59e0d'/><path d='M30 128l46-44 30 28 36-36 68 52' fill='none' stroke='#60bbf4' stroke-width='14' stroke-linecap='round' stroke-linejoin='round'/></svg>";
let markdownImageUrl = null;

function log(message) {
  console.log(`[desktop-feedback] ${message}`);
}

async function startMarkdownImageServer() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.url !== "/markdown-image.svg") {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "no-store",
      });
      response.end(markdownImageSvg);
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve the markdown image server port."));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/markdown-image.svg`,
      });
    });
  });
}

function makeDb() {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function readBootstrapIds() {
  const db = makeDb();
  try {
    const row = db
      .prepare(
        `
          SELECT
            p.project_id AS projectId,
            t.thread_id AS threadId
          FROM projection_projects p
          JOIN projection_threads t ON t.project_id = p.project_id
          ORDER BY t.created_at ASC, t.thread_id ASC
          LIMIT 1
        `,
      )
      .get();
    assert(row?.projectId, "Bootstrap project id was not created.");
    assert(row?.threadId, "Bootstrap thread id was not created.");
    return {
      projectId: row.projectId,
      threadId: row.threadId,
    };
  } finally {
    db.close();
  }
}

function resetThreadProjection(db, ids) {
  db.prepare("DELETE FROM projection_thread_messages WHERE thread_id = ?").run(ids.threadId);
  db.prepare("DELETE FROM projection_thread_activities WHERE thread_id = ?").run(ids.threadId);
  db.prepare("DELETE FROM projection_thread_proposed_plans WHERE thread_id = ?").run(ids.threadId);
  db.prepare("DELETE FROM projection_turns WHERE thread_id = ?").run(ids.threadId);
  db.prepare("DELETE FROM projection_pending_approvals WHERE thread_id = ?").run(ids.threadId);
}

function updateProjectAndThread(db, ids, input) {
  db.prepare(
    `
      UPDATE projection_projects
      SET title = ?,
          workspace_root = ?,
          default_model = ?,
          scripts_json = '[]',
          updated_at = ?
      WHERE project_id = ?
    `,
  ).run(input.projectTitle, repoRoot, "gpt-5.4", input.updatedAt, ids.projectId);

  db.prepare(
    `
      UPDATE projection_threads
      SET title = ?,
          model = ?,
          runtime_mode = 'full-access',
          interaction_mode = 'default',
          branch = 'main',
          worktree_path = NULL,
          latest_turn_id = ?,
          updated_at = ?,
          deleted_at = NULL
      WHERE thread_id = ?
    `,
  ).run(input.threadTitle, "gpt-5.4", input.latestTurnId, input.updatedAt, ids.threadId);
}

function upsertSession(db, ids, input) {
  db.prepare(
    `
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_session_id,
        provider_thread_id,
        runtime_mode,
        active_turn_id,
        last_error,
        updated_at
      )
      VALUES (?, ?, ?, NULL, NULL, 'full-access', ?, NULL, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        status = excluded.status,
        provider_name = excluded.provider_name,
        provider_session_id = excluded.provider_session_id,
        provider_thread_id = excluded.provider_thread_id,
        runtime_mode = excluded.runtime_mode,
        active_turn_id = excluded.active_turn_id,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
  ).run(ids.threadId, input.status, "codex", input.activeTurnId, input.updatedAt);
}

function insertMessage(db, input) {
  db.prepare(
    `
      INSERT INTO projection_thread_messages (
        message_id,
        thread_id,
        turn_id,
        role,
        text,
        attachments_json,
        is_streaming,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `,
  ).run(
    input.messageId,
    input.threadId,
    input.turnId,
    input.role,
    input.text,
    input.isStreaming ? 1 : 0,
    input.createdAt,
    input.updatedAt,
  );
}

function insertActivity(db, input) {
  db.prepare(
    `
      INSERT INTO projection_thread_activities (
        activity_id,
        thread_id,
        turn_id,
        tone,
        kind,
        summary,
        payload_json,
        created_at,
        sequence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.activityId,
    input.threadId,
    input.turnId,
    input.tone,
    input.kind,
    input.summary,
    JSON.stringify(input.payload),
    input.createdAt,
    input.sequence,
  );
}

function insertTurn(db, input) {
  db.prepare(
    `
      INSERT INTO projection_turns (
        thread_id,
        turn_id,
        pending_message_id,
        assistant_message_id,
        state,
        requested_at,
        started_at,
        completed_at,
        checkpoint_turn_count,
        checkpoint_ref,
        checkpoint_status,
        checkpoint_files_json
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]')
    `,
  ).run(
    input.threadId,
    input.turnId,
    input.assistantMessageId,
    input.state,
    input.requestedAt,
    input.startedAt,
    input.completedAt,
  );
}

function updateProjectionState(db, updatedAt) {
  const projectorNames = [
    "projects",
    "threads",
    "threadMessages",
    "threadProposedPlans",
    "threadActivities",
    "threadSessions",
    "checkpoints",
  ];
  for (const projector of projectorNames) {
    db.prepare(
      `
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(projector) DO UPDATE SET
          last_applied_sequence = excluded.last_applied_sequence,
          updated_at = excluded.updated_at
      `,
    ).run(projector, updatedAt);
  }
}

function seedStaticScenario(ids) {
  const db = makeDb();
  try {
    const turnId = "turn-static-1";
    resetThreadProjection(db, ids);
    updateProjectAndThread(db, ids, {
      projectTitle: "T3 Code",
      threadTitle: staticThreadTitle,
      latestTurnId: turnId,
      updatedAt: "2026-03-07T12:00:06.000Z",
    });
    upsertSession(db, ids, {
      status: "ready",
      activeTurnId: null,
      updatedAt: "2026-03-07T12:00:06.000Z",
    });
    insertMessage(db, {
      messageId: "msg-user-static-1",
      threadId: ids.threadId,
      turnId: null,
      role: "user",
      text: userMessageText,
      isStreaming: false,
      createdAt: "2026-03-07T12:00:00.000Z",
      updatedAt: "2026-03-07T12:00:00.000Z",
    });
    insertMessage(db, {
      messageId: "msg-assistant-static-1",
      threadId: ids.threadId,
      turnId,
      role: "assistant",
      text: assistantMessageText,
      isStreaming: false,
      createdAt: "2026-03-07T12:00:02.000Z",
      updatedAt: "2026-03-07T12:00:03.000Z",
    });
    insertActivity(db, {
      activityId: "activity-tool-1",
      threadId: ids.threadId,
      turnId,
      tone: "tool",
      kind: "tool.updated",
      summary: "Command run complete",
      payload: {
        data: {
          command: workCommand,
        },
      },
      createdAt: "2026-03-07T12:00:02.250Z",
      sequence: 1,
    });
    insertActivity(db, {
      activityId: "activity-tool-2",
      threadId: ids.threadId,
      turnId,
      tone: "tool",
      kind: "tool.completed",
      summary: "File change complete",
      payload: {
        data: {
          changes: [{ path: "apps/web/src/components/ChatView.tsx" }],
        },
      },
      createdAt: "2026-03-07T12:00:02.500Z",
      sequence: 2,
    });
    insertMessage(db, {
      messageId: "msg-assistant-static-2",
      threadId: ids.threadId,
      turnId,
      role: "assistant",
      text: `Preview this image:\n\n![diagram](${markdownImageUrl})`,
      isStreaming: false,
      createdAt: "2026-03-07T12:00:04.000Z",
      updatedAt: "2026-03-07T12:00:05.000Z",
    });
    insertTurn(db, {
      threadId: ids.threadId,
      turnId,
      assistantMessageId: "msg-assistant-static-2",
      state: "completed",
      requestedAt: "2026-03-07T12:00:00.250Z",
      startedAt: "2026-03-07T12:00:00.500Z",
      completedAt: "2026-03-07T12:00:05.000Z",
    });
    updateProjectionState(db, "2026-03-07T12:00:06.000Z");
  } finally {
    db.close();
  }
}

function seedRunningScenario(ids) {
  const db = makeDb();
  try {
    const turnId = "turn-running-1";
    resetThreadProjection(db, ids);
    updateProjectAndThread(db, ids, {
      projectTitle: "T3 Code",
      threadTitle: runningThreadTitle,
      latestTurnId: turnId,
      updatedAt: "2026-03-07T12:10:03.000Z",
    });
    upsertSession(db, ids, {
      status: "running",
      activeTurnId: turnId,
      updatedAt: "2026-03-07T12:10:03.000Z",
    });
    insertMessage(db, {
      messageId: "msg-user-running-1",
      threadId: ids.threadId,
      turnId: null,
      role: "user",
      text: "Tighten the prompt card layout and keep the working indicator obvious.",
      isStreaming: false,
      createdAt: "2026-03-07T12:10:00.000Z",
      updatedAt: "2026-03-07T12:10:00.000Z",
    });
    insertTurn(db, {
      threadId: ids.threadId,
      turnId,
      assistantMessageId: null,
      state: "running",
      requestedAt: "2026-03-07T12:10:00.250Z",
      startedAt: "2026-03-07T12:10:00.500Z",
      completedAt: null,
    });
    updateProjectionState(db, "2026-03-07T12:10:03.000Z");
  } finally {
    db.close();
  }
}

function completeRunningScenario(ids) {
  const db = makeDb();
  try {
    db.prepare(
      `
        UPDATE projection_thread_sessions
        SET status = 'ready',
            active_turn_id = NULL,
            updated_at = ?
        WHERE thread_id = ?
      `,
    ).run("2026-03-07T12:11:04.000Z", ids.threadId);
    db.prepare(
      `
        UPDATE projection_turns
        SET assistant_message_id = ?,
            state = 'completed',
            completed_at = ?
        WHERE thread_id = ? AND turn_id = ?
      `,
    ).run(
      "msg-assistant-running-1",
      "2026-03-07T12:11:03.500Z",
      ids.threadId,
      "turn-running-1",
    );
    insertMessage(db, {
      messageId: "msg-assistant-running-1",
      threadId: ids.threadId,
      turnId: "turn-running-1",
      role: "assistant",
      text: "Finished the layout cleanup and closed out the turn cleanly.",
      isStreaming: false,
      createdAt: "2026-03-07T12:11:03.000Z",
      updatedAt: "2026-03-07T12:11:03.500Z",
    });
    db.prepare(
      `
        UPDATE projection_threads
        SET updated_at = ?
        WHERE thread_id = ?
      `,
    ).run("2026-03-07T12:11:04.000Z", ids.threadId);
    updateProjectionState(db, "2026-03-07T12:11:04.000Z");
  } finally {
    db.close();
  }
}

async function launchDesktop() {
  const env = {
    ...process.env,
    T3CODE_STATE_DIR: stateDir,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
    T3CODE_DISABLE_AUTO_UPDATE: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronBinaryPath,
    args: [
      "--disable-gpu",
      "--disable-software-rasterizer",
      path.join(desktopDir, "dist-electron/main.js"),
    ],
    cwd: desktopDir,
    env,
  });
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setSize(size.width, size.height);
    window?.center();
  }, {
    width: 1280,
    height: 920,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function closeDesktop(app) {
  await app.close();
  await delay(250);
}

async function preparePage(page, threadTitle, appSettings = {}) {
  await page.evaluate((settings) => {
    localStorage.clear();
    localStorage.setItem("t3code:theme", "dark");
    localStorage.setItem("t3code:app-settings:v1", JSON.stringify(settings));
  }, appSettings);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(threadTitle, { exact: true }).first().waitFor({ timeout: 15_000 });
}

function measureContrast(element) {
  // These helpers must stay inside the page function because Playwright serializes
  // the function body that runs in the browser context.
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const sampleColor = (value) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create a canvas context for color sampling.");
    }
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return {
      r,
      g,
      b,
      a: a / 255,
    };
  };
  const parseColor = (value) => {
    if (value.startsWith("rgb")) {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) {
        throw new Error(`Unsupported color value: ${value}`);
      }
      const [r, g, b, a = "1"] = match[1].split(",").map((entry) => entry.trim());
      return {
        r: Number(r),
        g: Number(g),
        b: Number(b),
        a: Number(a),
      };
    }
    return sampleColor(value);
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const compositeColor = (top, bottom) => {
    const alpha = top.a + bottom.a * (1 - top.a);
    if (alpha <= 0) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
      a: alpha,
    };
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const toLuminance = (channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const relativeLuminance = (color) =>
    0.2126 * toLuminance(color.r) +
    0.7152 * toLuminance(color.g) +
    0.0722 * toLuminance(color.b);

  const text = parseColor(getComputedStyle(element).color);
  const layers = [];
  let node = element;
  while (node) {
    layers.push(parseColor(getComputedStyle(node).backgroundColor));
    node = node.parentElement;
  }
  let background = { r: 0, g: 0, b: 0, a: 1 };
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    background = compositeColor(layers[index], background);
  }

  const lighter = Math.max(relativeLuminance(text), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(text), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function contrastRatioForLocator(locator) {
  return locator.evaluate(measureContrast);
}

async function userTimestampDisplay(page) {
  const userBubble = page
    .locator("pre")
    .filter({ hasText: userMessageText })
    .first();
  return userBubble.evaluate((pre) => {
    const bubble = pre.parentElement;
    const metadataRow = bubble?.lastElementChild;
    if (!(metadataRow instanceof HTMLElement)) {
      throw new Error("Unable to find the user-message metadata row.");
    }
    return getComputedStyle(metadataRow).display;
  });
}

async function validateStaticScenario(ids) {
  seedStaticScenario(ids);
  const { app, page } = await launchDesktop();
  try {
    await preparePage(page, staticThreadTitle);

    await page.getByRole("button", { name: "Settings" }).first().waitFor();

    const assistantText = page
      .locator(".chat-markdown")
      .filter({ hasText: assistantMessageText })
      .first();
    const workText = page.getByText("File change complete").first();
    const assistantContrast = await contrastRatioForLocator(assistantText);
    const workContrast = await contrastRatioForLocator(workText);
    assert(
      assistantContrast >= 8,
      `Assistant text contrast regressed to ${assistantContrast.toFixed(2)}.`,
    );
    assert(workContrast >= 6, `Work-log contrast regressed to ${workContrast.toFixed(2)}.`);

    const hiddenDisplay = await userTimestampDisplay(page);
    assert.equal(hiddenDisplay, "none", "User message metadata still reserves vertical space.");
    await page
      .locator("pre")
      .filter({ hasText: userMessageText })
      .first()
      .hover();
    const visibleDisplay = await userTimestampDisplay(page);
    assert.notEqual(visibleDisplay, "none", "User message metadata did not reappear on hover.");

    await page.getByText("Tool calls (2)").first().waitFor();
    assert.equal(
      await page.getByText(workCommand, { exact: true }).count(),
      0,
      "Tool-command details should start collapsed.",
    );
    await page.getByRole("button", { name: "Expand" }).first().click();
    await page.getByText(workCommand, { exact: true }).waitFor();

    await page.locator(".chat-markdown-image-button").first().click();
    await page.getByRole("dialog", { name: "Expanded image preview" }).waitFor();

    await page.screenshot({
      path: path.join(artifactDir, "static-preview.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Close image preview" }).last().click();
  } finally {
    await closeDesktop(app);
  }
}

async function navigateBackToThread(page, threadTitle) {
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  const threadTitleLocator = page.getByText(threadTitle, { exact: true }).first();
  const threadButtonVisible = await threadTitleLocator
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (threadButtonVisible) {
    return;
  }
  await page.getByText(threadTitle, { exact: true }).last().click();
  await page.getByText(threadTitle, { exact: true }).first().waitFor({ timeout: 10_000 });
}

async function validateRunningScenario(ids) {
  seedRunningScenario(ids);
  const { app, page } = await launchDesktop();
  try {
    await preparePage(page, runningThreadTitle, {
      busyTurnSubmissionBehavior: "steer",
    });
    const runningComposer = page.locator('[contenteditable="true"]').first();
    await runningComposer.click();
    await page.keyboard.type(previewBusyActionText);
    const steerButton = page.getByRole("button", { name: "Steer now" });
    const steerVisible = await steerButton
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!steerVisible) {
      const buttonLabels = await page.locator("button").evaluateAll((buttons) =>
        buttons
          .map((button) => (button.textContent ?? "").trim() || button.getAttribute("aria-label") || "")
          .filter((label) => label.length > 0),
      );
      await page.screenshot({
        path: path.join(artifactDir, "running-debug.png"),
        fullPage: true,
      });
      throw new Error(`Unable to find the running primary action. Buttons: ${buttonLabels.join(" | ")}`);
    }
    const loaderLabel = page.getByText(/Working for/).first();
    const verticalAlignmentDelta = await loaderLabel.evaluate((label) => {
      const dots = label.previousElementSibling;
      if (!(dots instanceof HTMLElement)) {
        throw new Error("Unable to find the working indicator dot grid.");
      }
      const labelRect = label.getBoundingClientRect();
      const dotsRect = dots.getBoundingClientRect();
      const labelCenter = labelRect.top + labelRect.height / 2;
      const dotsCenter = dotsRect.top + dotsRect.height / 2;
      return Math.abs(labelCenter - dotsCenter);
    });
    assert(
      verticalAlignmentDelta <= 4,
      `Working indicator is vertically misaligned by ${verticalAlignmentDelta.toFixed(2)}px.`,
    );

    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    await page.getByText("General").waitFor();
    const queueOption = page.getByRole("radio", { name: /Queue next turn/i });
    await queueOption.click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="radio"]')].some(
          (element) =>
            element.getAttribute("aria-checked") === "true" &&
            (element.textContent ?? "").includes("Queue next turn"),
        ),
    );

    await navigateBackToThread(page, runningThreadTitle);
    const queueButton = page.getByRole("button", { name: "Queue next" });
    let expectedQueuedText = previewBusyActionText;
    const queueButtonVisible = await queueButton
      .waitFor({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!queueButtonVisible) {
      await runningComposer.click();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
      await page.keyboard.press("Backspace");
      await page.keyboard.type(queuedFollowUpText);
      await queueButton.waitFor();
      expectedQueuedText = queuedFollowUpText;
    }

    await page.getByRole("button", { name: "Queue next" }).click();
    await page.getByText("Queued next turn").waitFor();
    await page.getByText(expectedQueuedText).waitFor();

    await page.screenshot({
      path: path.join(artifactDir, "running-queue.png"),
      fullPage: true,
    });
  } finally {
    await closeDesktop(app);
  }
}

function activateFinder() {
  execFileSync("osascript", ["-e", 'tell application "Finder" to activate']);
}

function activateApp() {
  execFileSync("osascript", ["-e", `tell application "${appName}" to activate`]);
}

async function blurWindow(app) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.blur();
  });
  try {
    activateFinder();
  } catch {
    // Ignore AppleScript failures; BrowserWindow.blur is the primary mechanism.
  }
  await delay(750);
}

async function focusWindow(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.focus();
  });
  try {
    activateApp();
  } catch {
    // Ignore AppleScript failures; BrowserWindow.focus is the primary mechanism.
  }
  await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3_000 }).catch(() => undefined);
  await page.evaluate(() => {
    for (const eventName of ["focus", "pageshow", "online"]) {
      window.dispatchEvent(new Event(eventName));
    }
  });
  await delay(750);
}

async function validateFocusHealingScenario(ids) {
  seedRunningScenario(ids);
  const { app, page } = await launchDesktop();
  try {
    await preparePage(page, runningThreadTitle, {
      busyTurnSubmissionBehavior: "steer",
    });
    await page.getByText(/Working for/).waitFor();
    await blurWindow(app);
    completeRunningScenario(ids);
    await focusWindow(app, page);
    await page.getByText("Finished the layout cleanup and closed out the turn cleanly.").waitFor({
      timeout: 20_000,
    });
    assert.equal(
      await page.getByText(/Working for/).count(),
      0,
      "The running indicator did not clear after the focus resync.",
    );

    await page.screenshot({
      path: path.join(artifactDir, "focus-healed.png"),
      fullPage: true,
    });
  } finally {
    await closeDesktop(app);
  }
}

async function bootstrapStateDir() {
  const { app, page } = await launchDesktop();
  try {
    await page.getByText("New thread", { exact: true }).first().waitFor({ timeout: 15_000 });
  } finally {
    await closeDesktop(app);
  }
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const markdownImageServer = await startMarkdownImageServer();
  markdownImageUrl = markdownImageServer.url;
  log(`State dir: ${stateDir}`);
  try {
    log("Bootstrapping the state database through the real desktop app...");
    await bootstrapStateDir();
    const ids = readBootstrapIds();
    log(`Using project ${ids.projectId} and thread ${ids.threadId}.`);

    log("Validating static thread behaviors...");
    await validateStaticScenario(ids);

    log("Validating running-turn controls and settings...");
    await validateRunningScenario(ids);

    log("Validating focus-healing for stale running state...");
    await validateFocusHealingScenario(ids);

    log(`Desktop feedback validation passed. Screenshots saved to ${artifactDir}.`);
  } finally {
    await new Promise((resolve, reject) => {
      markdownImageServer.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
