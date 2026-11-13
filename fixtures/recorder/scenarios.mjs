import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

// Scenario drivers. Each gets a fresh page in a shared browser context, so scenario 2 onward
// reuses the session cookie that scenario 1 earned by pairing.

/** Waits until no /ws frame or HTTP exchange arrived for `quietMs`. */
async function settle(ctx, quietMs = 3000, maxMs = 30_000) {
  const start = Date.now();
  let last = -1;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    const n =
      ctx.cap.lines.filter((l) => l.frame?._tag !== "Ping" && l.frame?._tag !== "Pong").length +
      ctx.cap.http.length;
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) return;
    await ctx.page.waitForTimeout(250);
  }
}

async function dump(ctx, label) {
  await ctx.shot(label);
  if (process.argv.includes("--explore")) {
    const names = await ctx.page
      .locator("button, [role=button], a[href], textarea, [contenteditable=true]")
      .evaluateAll((els) =>
        els
          .filter((e) => e.offsetParent !== null)
          .map(
            (e) =>
              `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 60)}"${e.getAttribute("href") ? ` href=${e.getAttribute("href")}` : ""}`,
          ),
      );
    ctx.log(label, "url", ctx.page.url(), "\n  " + names.join("\n  "));
  }
}

async function pairing(ctx) {
  await ctx.page.goto(`${ctx.server.origin}/pair#token=${ctx.server.token}`);
  await ctx.page.waitForURL((u) => !u.pathname.startsWith("/pair"), { timeout: 30_000 });
  await settle(ctx);
  await dump(ctx, "after-pair");
  if (new URL(ctx.page.url()).pathname === "/welcome") {
    // Fresh server: skip importing the host's agent history; keep only the bootstrapped project.
    const box = ctx.page.getByRole("checkbox").first();
    if (await box.isChecked().catch(() => false)) await box.click();
    await ctx.page.getByRole("button", { name: "Start", exact: true }).click();
    await ctx.page.waitForURL((u) => u.pathname !== "/welcome", { timeout: 30_000 });
    await settle(ctx);
  }
  await dump(ctx, "idle");
}

async function reconnect(ctx) {
  await ctx.page.goto(`${ctx.server.origin}/`);
  await ctx.page.getByRole("button", { name: "New thread" }).first().waitFor({ timeout: 30_000 });
  await settle(ctx);
  await dump(ctx, "idle");
}

/** Opens the app, starts a draft thread in the project, and picks Claude Haiku 5.5. */
async function newHaikuThread(ctx, runtimeLabel) {
  await reconnect(ctx);
  await ctx.page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.pathname.startsWith("/draft/"), { timeout: 15_000 });
  await ctx.page
    .getByRole("button", { name: /^(GPT|Claude|Codex)/ })
    .first()
    .click();
  await ctx.page.getByPlaceholder("Search models...").fill("Haiku 5.5");
  await ctx.page
    .getByRole("option", { name: /Claude Haiku 5\.5/ })
    .first()
    .click();
  if (runtimeLabel) {
    // The permissions menu sits in the model picker's footer.
    await ctx.page.locator("[data-composer-permissions-trigger]").first().click();
    await ctx.page.getByRole("menuitemradio", { name: runtimeLabel, exact: true }).click();
    await ctx.page.keyboard.press("Escape");
  }
  await ctx.page.keyboard.press("Escape");
  await dump(ctx, "draft");
}

async function send(ctx, text) {
  const box = ctx.page.locator("[contenteditable=true]").first();
  await box.click();
  await ctx.page.keyboard.type(text);
  await ctx.page.getByRole("button", { name: "Submit message" }).click();
  await ctx.page
    .waitForURL((u) => !u.pathname.startsWith("/draft/"), { timeout: 30_000 })
    .catch(() => {});
}

const stopButton = (ctx) => ctx.page.getByRole("button", { name: /^(Stop generation|Stopping)$/ });

async function waitTurnEnd(ctx, timeout = 120_000) {
  await stopButton(ctx)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});
  await stopButton(ctx).first().waitFor({ state: "detached", timeout });
  await settle(ctx, 4000, 60_000);
}

async function turn(ctx) {
  await newHaikuThread(ctx, null);
  await send(ctx, "Reply with exactly: hello from haiku");
  await waitTurnEnd(ctx);
  await dump(ctx, "done");
}

async function permission(ctx) {
  await newHaikuThread(ctx, "Supervised");
  await send(
    ctx,
    "Run the shell command `echo conn-recording` with your Bash tool, then reply with its output only.",
  );
  const approve = ctx.page.getByRole("button", { name: /^(Approve|Allow once)$/ }).first();
  await approve.waitFor({ state: "visible", timeout: 120_000 });
  await settle(ctx, 1500, 15_000);
  await dump(ctx, "approval");
  await approve.click();
  await waitTurnEnd(ctx);
  await dump(ctx, "done");
}

async function interrupt(ctx) {
  await newHaikuThread(ctx, null);
  // A slow tool call gives a stable window to interrupt in; Haiku's text answers arrive too fast.
  await send(
    ctx,
    "Run the shell command `ping -c 30 127.0.0.1` with your Bash tool, then reply with: done",
  );
  await stopButton(ctx).first().waitFor({ state: "visible", timeout: 30_000 });
  // The scratch project's ask rule may prompt for Bash even in full access; approve so it runs.
  const approve = ctx.page.getByRole("button", { name: /^(Approve|Allow once)$/ }).first();
  await approve.waitFor({ state: "visible", timeout: 20_000 }).then(
    () => approve.click(),
    () => {},
  );
  const deadline = Date.now() + 60_000;
  while (
    Date.now() < deadline &&
    !ctx.cap.lines.some((l) => l.dir === "out" && JSON.stringify(l.frame).includes("ping -c 30"))
  ) {
    await ctx.page.waitForTimeout(200);
  }
  await ctx.page.waitForTimeout(2000);
  await dump(ctx, "running");
  await stopButton(ctx).first().click();
  await stopButton(ctx).first().waitFor({ state: "detached", timeout: 60_000 });
  await settle(ctx, 4000, 60_000);
  await dump(ctx, "done");
}

/**
 * Pairs a second, fresh server as a remote environment from Settings > Connections. This is the
 * path Conn desktop takes to an Orbit container: bearer tokens and WebSocket tickets, not the
 * same-origin session cookie. Only traffic to the second server is recorded.
 */
async function remote(ctx) {
  const target = await ctx.startServer();
  await ctx.page.goto(`${ctx.server.origin}/settings/connections`);
  await settle(ctx);
  ctx.cap.only(new URL(target.origin).host);
  await ctx.page.getByRole("button", { name: "Add environment" }).first().click();
  const dialog = ctx.page.getByRole("dialog", { name: "Add Environment" });
  const remoteCard = dialog.getByRole("button", { name: /Remote link/ });
  if ((await remoteCard.getAttribute("aria-pressed")) !== "true") await remoteCard.click();
  await dialog
    .getByPlaceholder("backend.example.com")
    .fill(`${target.origin}/pair#token=${target.token}`);
  await dump(ctx, "dialog");
  await dialog.getByRole("button", { name: "Add environment", exact: true }).click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    !ctx.cap.lines.some((l) => l.frame?.tag === "orchestration.subscribeShell")
  ) {
    await ctx.page.waitForTimeout(200);
  }
  await settle(ctx, 4000, 60_000);
  await dump(ctx, "added");
  // The thread list now shows the remote environment's bootstrapped thread.
  await ctx.page.goto(`${ctx.server.origin}/`);
  await settle(ctx, 4000, 60_000);
  await dump(ctx, "home");
}

/** Pairs the Rust conn-server from Settings › Connections, as `remote` does. Records only it. */
async function pairRust(ctx) {
  return pairTarget(ctx, await ctx.startRustServer());
}

/**
 * Pairs `target` (a TypeScript or Conn Server started by the recorder) from Settings ›
 * Connections and records only its traffic.
 */
async function pairTarget(ctx, target) {
  await ctx.page.goto(`${ctx.server.origin}/settings/connections`);
  await settle(ctx);
  ctx.cap.only(new URL(target.origin).host);
  await ctx.page.getByRole("button", { name: "Add environment" }).first().click();
  const dialog = ctx.page.getByRole("dialog", { name: "Add Environment" });
  const remoteCard = dialog.getByRole("button", { name: /Remote link/ });
  if ((await remoteCard.getAttribute("aria-pressed")) !== "true") await remoteCard.click();
  await dialog
    .getByPlaceholder("backend.example.com")
    .fill(`${target.origin}/pair#token=${target.token}`);
  await dialog.getByRole("button", { name: "Add environment", exact: true }).click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  await settle(ctx, 3000, 30_000);
  await dump(ctx, "rust-added");
  await ctx.page.goto(`${ctx.server.origin}/`);
  await settle(ctx, 3000, 30_000);
  await dump(ctx, "rust-home");
  return target;
}

/** On the Rust environment's draft: picks Claude Haiku 5.5 and, if given, a runtime mode. */
async function rustHaikuDraft(ctx, runtimeLabel, projectName = "rust-project") {
  // "New thread" opens a project picker; each paired environment has its own project name.
  await ctx.page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await ctx.page.getByRole("dialog").getByText(projectName, { exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.pathname.startsWith("/draft/"), { timeout: 15_000 });
  await ctx.page
    .getByText(new RegExp(`What should we build in\\s*${projectName}`))
    .first()
    // A hidden copy of the heading exists only for the draft's own project.
    .waitFor({ state: "attached", timeout: 15_000 });
  // The model button names the environment's default model: Claude here, a Codex model on a
  // TypeScript server whose default provider is Codex.
  await ctx.page
    .getByRole("button", { name: /^(Claude|GPT|Codex|\d+ \w+ (Low|Medium|High))/ })
    .first()
    .click();
  await ctx.page.getByPlaceholder("Search models...").fill("Haiku 5.5");
  await ctx.page
    .getByRole("option", { name: /Claude Haiku 5\.5/ })
    .first()
    .click();
  if (runtimeLabel) {
    await ctx.page.locator("[data-composer-permissions-trigger]").first().click();
    await ctx.page.getByRole("menuitemradio", { name: runtimeLabel, exact: true }).click();
    await ctx.page.keyboard.press("Escape");
  }
  await ctx.page.keyboard.press("Escape");
  await dump(ctx, "draft");
}

/** Field-wise maximum of two memory samples. */
const peak = (a, b) =>
  Object.fromEntries(Object.keys(b).map((k) => [k, Math.max(a[k] ?? 0, b[k] ?? 0)]));

/** Sends one message in the open thread and waits until `reply` shows. */
async function rustMessage(ctx, reply) {
  await send(ctx, `Reply with exactly: ${reply}`);
  await waitTurnEnd(ctx);
  // Whole text only, so the user's bubble never matches; models may change case or add a period.
  // The fake provider answers "echo: <message>".
  const whole = new RegExp(`^(echo: Reply with exactly: )?${reply}\\.?$`, "i");
  await ctx.page.getByText(whole).last().waitFor({ timeout: 30_000 });
}

async function rustTurn(ctx) {
  const target = await pairRust(ctx);
  const memory = { idle: ctx.memory(target, "connected"), during: {} };
  await rustHaikuDraft(ctx, null);
  await send(ctx, "Reply with exactly: hello from haiku");
  // Peak while the stop button shows: the turn is running.
  await stopButton(ctx)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});
  while (await stopButton(ctx).first().isVisible()) {
    memory.during = peak(memory.during, ctx.memory(target, "during-turn"));
    await ctx.page.waitForTimeout(100);
  }
  await waitTurnEnd(ctx);
  await ctx.page.getByText("hello from haiku").last().waitFor({ timeout: 30_000 });
  memory.after = ctx.memory(target, "after-turn");
  ctx.log(`memory KB ${JSON.stringify(memory)}`);
  await ctx.shotAlways("turn");
  ctx.rust = target;
}

/**
 * rust-turn, then ten more turns in three threads (three more here, four and three in two new
 * threads), then two idle minutes. Samples memory after the turns and after the idle time.
 */
async function rustLoad(ctx) {
  await rustTurn(ctx);
  for (let i = 1; i <= 3; i++) await rustMessage(ctx, `first thread ${i}`);
  for (const [thread, turns] of [
    ["second", 4],
    ["third", 3],
  ]) {
    await rustHaikuDraft(ctx, null);
    for (let i = 1; i <= turns; i++) await rustMessage(ctx, `${thread} thread ${i}`);
  }
  await ctx.shotAlways("load");
  ctx.memory(ctx.rust, "after-11-turns");
  await ctx.page.waitForTimeout(120_000);
  ctx.memory(ctx.rust, "idle-2min");
}

/**
 * After rust-turn: restarts the Rust server on the same state and port without reloading the
 * page. The client must reconnect by itself, show the thread, and take a second message.
 */
async function rustRestart(ctx) {
  await rustTurn(ctx);
  await ctx.stopServer(ctx.rust);
  const banner = ctx.page.getByText(/ is reconnecting/);
  await banner.first().waitFor({ timeout: 30_000 });
  await ctx.shotAlways("server-down");
  const sockets = ctx.cap.http.filter((h) => h.upgrade === "websocket").length;
  ctx.rust = await ctx.startRustServer(ctx.rust);
  await banner.first().waitFor({ state: "detached", timeout: 90_000 });
  const reconnected = ctx.cap.http.filter((h) => h.upgrade === "websocket").length > sockets;
  ctx.log(`reconnected on a new socket without a reload: ${reconnected}`);
  if (!reconnected) throw new Error("the client did not open a new socket");
  await ctx.page.getByText("hello from haiku").last().waitFor({ timeout: 30_000 });
  await settle(ctx, 3000, 30_000);
  await ctx.shotAlways("after-restart");
  await send(ctx, "Reply with exactly: second turn after restart");
  await waitTurnEnd(ctx);
  await ctx.page.getByText("second turn after restart").last().waitFor({ timeout: 30_000 });
  await ctx.shotAlways("after-restart-turn");
}

async function rustPermission(ctx) {
  await pairRust(ctx);
  await rustHaikuDraft(ctx, "Supervised");
  await send(
    ctx,
    "Run the shell command `echo conn-recording` with your Bash tool, then reply with its output only.",
  );
  const approve = ctx.page.getByRole("button", { name: /^(Approve|Allow once)$/ }).first();
  await approve.waitFor({ state: "visible", timeout: 120_000 });
  await settle(ctx, 1500, 15_000);
  await ctx.shotAlways("approval");
  await approve.click();
  await waitTurnEnd(ctx);
  await ctx.shotAlways("permission");
}

async function rustStop(ctx) {
  await pairRust(ctx);
  await rustHaikuDraft(ctx, null);
  await send(
    ctx,
    "Run the shell command `ping -c 30 127.0.0.1` with your Bash tool, then reply with: done",
  );
  await stopButton(ctx).first().waitFor({ state: "visible", timeout: 30_000 });
  const approve = ctx.page.getByRole("button", { name: /^(Approve|Allow once)$/ }).first();
  await approve.waitFor({ state: "visible", timeout: 20_000 }).then(
    () => approve.click(),
    () => {},
  );
  const deadline = Date.now() + 60_000;
  while (
    Date.now() < deadline &&
    !ctx.cap.lines.some((l) => l.dir === "out" && JSON.stringify(l.frame).includes("ping -c 30"))
  ) {
    await ctx.page.waitForTimeout(200);
  }
  await ctx.page.waitForTimeout(2000);
  await ctx.shotAlways("running");
  await stopButton(ctx).first().click();
  await stopButton(ctx).first().waitFor({ state: "detached", timeout: 60_000 });
  await settle(ctx, 4000, 60_000);
  await ctx.shotAlways("stopped");
}

/**
 * Settings and access on a paired remote environment: change a server setting, then list the
 * environment's clients and revoke one that its CLI issued. `rust` picks the Conn Server.
 */
async function settingsAndAccess(ctx, rust) {
  const target = await pairTarget(
    ctx,
    rust ? await ctx.startRustServer() : await ctx.startServer(),
  );
  const environmentId = (await (await fetch(`${target.origin}/.well-known/t3/environment`)).json())
    .environmentId;
  const bot = "Recorder bot";
  const botSession = ctx.issueSession(target, bot);
  ctx.log(`issued ${botSession}`);

  await ctx.page.goto(`${ctx.server.origin}/settings/threads?machine=${environmentId}`);
  await settle(ctx, 3000, 30_000);
  await dump(ctx, "threads-settings");
  const toggle = ctx.page.getByRole("switch").first();
  await toggle.waitFor({ timeout: 15_000 });
  const before = await toggle.getAttribute("aria-checked");
  await toggle.click();
  const deadline = Date.now() + 15_000;
  while (
    Date.now() < deadline &&
    !ctx.cap.lines.some((l) => l.frame?.tag === "server.updateSettings")
  ) {
    await ctx.page.waitForTimeout(200);
  }
  await settle(ctx, 2000, 15_000);
  const after = await toggle.getAttribute("aria-checked");
  ctx.log(`setting switched ${before} -> ${after}`);
  if (before === after) throw new Error("the setting did not change");
  await ctx.shotAlways("setting-changed");

  await ctx.page.goto(`${ctx.server.origin}/settings/access?machine=${environmentId}`);
  await settle(ctx, 3000, 30_000);
  await ctx.page.getByText("Authorized clients", { exact: true }).first().click();
  await dump(ctx, "access");
  const row = ctx.page.getByText(bot, { exact: false }).first();
  await row.waitFor({ timeout: 15_000 });
  await ctx.shotAlways("access");
  const revoke = ctx.page
    .locator("li, [role=listitem], [data-slot=item], div")
    .filter({ hasText: bot })
    .getByRole("button", { name: /^Revoke/ })
    .last();
  await revoke.click();
  const confirm = ctx.page.getByRole("alertdialog").getByRole("button", { name: /^Revoke/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await ctx.page.getByText(bot).first().waitFor({ state: "detached", timeout: 15_000 });
  await settle(ctx, 2000, 15_000);
  await ctx.shotAlways("revoked");
}

/**
 * The same scenario against a paired TypeScript server (`ts-*`) or the Conn Server (`rust-*`),
 * so the recordings and screenshots of the two compare side by side.
 */
function both(run) {
  return {
    ts: async (ctx) =>
      run(ctx, await pairTarget(ctx, await ctx.startServer("ts-project")), "ts-project"),
    rust: async (ctx) => run(ctx, await pairRust(ctx), "rust-project"),
  };
}

/** A message sent while a turn runs: the client's default follow-up (steer, else queue). */
const followUp = both(async (ctx, _target, projectName) => {
  await rustHaikuDraft(ctx, null, projectName);
  await send(ctx, "Count from 1 to 150, one number per line, nothing else.");
  await stopButton(ctx).first().waitFor({ state: "visible", timeout: 30_000 });
  const box = ctx.page.locator("[contenteditable=true]").first();
  await box.click();
  await ctx.page.keyboard.type("Then reply with exactly: follow-up done");
  await ctx.page.keyboard.press("Enter");
  await settle(ctx, 800, 5_000);
  await ctx.shotAlways("follow-up-sent");
  await ctx.page
    .getByText(/^follow-up done\.?$/i)
    .last()
    .waitFor({ timeout: 120_000 });
  await waitTurnEnd(ctx);
  await ctx.shotAlways("follow-up-done");
});

/** A message queued explicitly (the composer's alternate send) while a turn runs. */
const queued = both(async (ctx, _target, projectName) => {
  await rustHaikuDraft(ctx, null, projectName);
  await send(ctx, "Count from 1 to 150, one number per line, nothing else.");
  await stopButton(ctx).first().waitFor({ state: "visible", timeout: 30_000 });
  const box = ctx.page.locator("[contenteditable=true]").first();
  await box.click();
  await ctx.page.keyboard.type("Reply with exactly: queued done");
  // The alternate modifier flips the follow-up behaviour from steer to queue.
  await ctx.page.keyboard.press("ControlOrMeta+Enter");
  await settle(ctx, 800, 5_000);
  await ctx.shotAlways("queued-while-running");
  await ctx.page
    .getByText(/^queued done\.?$/i)
    .last()
    .waitFor({ timeout: 120_000 });
  await waitTurnEnd(ctx);
  await ctx.shotAlways("queued-done");
});

/** One turn with a rare word, then the command palette searches for it. */
const search = both(async (ctx, _target, projectName) => {
  await rustHaikuDraft(ctx, null, projectName);
  await send(ctx, "Reply with exactly: periwinkle lighthouse");
  await waitTurnEnd(ctx);
  await ctx.page.keyboard.press("Meta+k");
  await ctx.page.keyboard.type("lighthouse");
  await settle(ctx, 1500, 15_000);
  await ctx.shotAlways("search");
  await ctx.page.keyboard.press("Escape");
});

/**
 * Gives a target's scratch project a feature branch with one commit, an edited tracked file and
 * an untracked file, so status, refs and the diff have something to show.
 */
function prepareVcsRepo(project) {
  const git = (...a) =>
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "user.name=rec",
        "-c",
        "user.email=rec@example.com",
        "-c",
        "commit.gpgsign=false",
        ...a,
      ],
      { cwd: project, stdio: "ignore" },
    );
  git("branch", "other");
  git("checkout", "-q", "-b", "feature/review");
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# scratch\n\nA committed line.\n");
  git("commit", "-qam", "Add a line");
  NodeFS.writeFileSync(
    NodePath.join(project, "README.md"),
    "# scratch\n\nA committed line.\nAn uncommitted line.\n",
  );
  NodeFS.writeFileSync(NodePath.join(project, "notes.txt"), "untracked\n");
}

/**
 * The VCS views on a paired environment: the draft's branch, the branch picker, and the diff
 * panel. The same steps run against the T3 server (`vcs`) and the Conn Server (`rust-vcs`).
 */
async function vcsViews(ctx, target, projectName) {
  await pairTarget(ctx, target);
  await ctx.page.goto(`${ctx.server.origin}/`);
  await settle(ctx, 3000, 30_000);
  await ctx.page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await ctx.page.getByRole("dialog").getByText(projectName, { exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.pathname.startsWith("/draft/"), { timeout: 15_000 });
  await settle(ctx, 3000, 30_000);
  await ctx.shotAlways("draft");
  await dump(ctx, "draft");
  // The composer footer's branch control is a combobox-role button.
  const branch = ctx.page
    .locator("button", { hasText: "feature/review" })
    .locator("visible=true")
    .last();
  await branch.waitFor({ timeout: 30_000 });
  await branch.click();
  await ctx.page
    .getByText("other", { exact: true })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 30_000 });
  await settle(ctx, 2000, 15_000);
  await ctx.shotAlways("branches");
  await dump(ctx, "branches");
  await ctx.page.keyboard.press("Escape");
  // The diff opens from a server thread only, so one short Haiku turn makes one.
  await ctx.page
    .getByRole("button", { name: /^(GPT|Claude|Codex)/ })
    .locator("visible=true")
    .first()
    .click();
  await ctx.page.getByPlaceholder("Search models...").fill("Haiku 5.5");
  await ctx.page
    .getByRole("option", { name: /Claude Haiku 5\.5/ })
    .first()
    .click();
  await ctx.page.keyboard.press("Escape");
  await send(ctx, "Reply with exactly: ok");
  await waitTurnEnd(ctx);
  await ctx.page
    .locator("button", { hasText: /^Changes/ })
    .locator("visible=true")
    .first()
    .click();
  await ctx.page
    .getByText("notes.txt")
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 30_000 });
  await settle(ctx, 3000, 30_000);
  // Expanding a file loads its own patch (`review.getDiffPreview` with `file`).
  // Expand by the row's chevron; the file name itself opens the file viewer.
  const name = await ctx.page.getByText("README.md").locator("visible=true").last().boundingBox();
  await ctx.page.mouse.click(name.x - 40, name.y + name.height / 2);
  await ctx.page
    .getByText("An uncommitted line.")
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 30_000 });
  await settle(ctx, 2000, 15_000);
  await ctx.shotAlways("diff");
  await dump(ctx, "diff");
}

async function vcs(ctx) {
  const target = await ctx.startServer("ts-project", prepareVcsRepo);
  await vcsViews(ctx, target, "ts-project");
}

async function rustVcs(ctx) {
  const target = await ctx.startRustServer(undefined, prepareVcsRepo);
  const start = ctx.memory(target, "started");
  await vcsViews(ctx, target, "rust-project");
  // Status and branch streams are open on the project here.
  ctx.log(`memory KB ${JSON.stringify({ start, diff: ctx.memory(target, "diff-open") })}`);
}

/** A solid 24×24 PNG, built here so the fixture needs no binary file. */
function solidPng(r, g, b) {
  const size = 24;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat()),
  ]);
  const pixels = NodeZlib.deflateSync(Buffer.concat(Array(size).fill(row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Files the `*-files` scenarios find: a favicon, source to search, an ignored file. */
function seedFiles(project) {
  const put = (rel, data) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(project, rel)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(project, rel), data);
  };
  put(
    "favicon.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#e5484d"/></svg>',
  );
  put("src/hello.ts", 'export const greeting = "hello parity";\n');
  put("src/helper.ts", "export const helper = 1;\n");
  put(".gitignore", "*.log\n");
  put("debug.log", "ignored\n");
}

/**
 * Files, search and attachments, with no model call: the sidebar favicon, an `@` mention search,
 * an image attached to the composer (uploaded, not sent), a project content search, and the hit
 * opened in the file viewer. `ts-files` pairs a second TypeScript server, `rust-files` the
 * Conn Server, so the two recordings compare call by call.
 */
async function filesOn(ctx, rust) {
  const target = rust ? await ctx.startRustServer() : await ctx.startServer();
  const projectName = rust ? "rust-project" : "project";
  seedFiles(target.project);
  await ctx.page.goto(`${ctx.server.origin}/settings/connections`);
  await settle(ctx);
  ctx.cap.only(new URL(target.origin).host);
  await ctx.page.getByRole("button", { name: "Add environment" }).first().click();
  const dialog = ctx.page.getByRole("dialog", { name: "Add Environment" });
  const remoteCard = dialog.getByRole("button", { name: /Remote link/ });
  if ((await remoteCard.getAttribute("aria-pressed")) !== "true") await remoteCard.click();
  await dialog
    .getByPlaceholder("backend.example.com")
    .fill(`${target.origin}/pair#token=${target.token}`);
  await dialog.getByRole("button", { name: "Add environment", exact: true }).click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  await settle(ctx, 3000, 30_000);
  await ctx.page.goto(`${ctx.server.origin}/`);
  await settle(ctx, 3000, 30_000);
  await ctx.shotAlways("home");

  await ctx.page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await ctx.page.getByRole("dialog").getByText(projectName, { exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.pathname.startsWith("/draft/"), { timeout: 15_000 });
  await settle(ctx, 2000, 15_000);
  await dump(ctx, "draft");

  const composer = ctx.page.locator("[contenteditable=true]").first();
  await composer.click();
  await ctx.page.keyboard.type("@hello");
  await ctx.page.getByText("hello.ts").first().waitFor({ timeout: 15_000 });
  await settle(ctx, 1500, 15_000);
  await ctx.shotAlways("mention");
  await ctx.page.keyboard.press("Escape");
  for (let i = 0; i < 6; i++) await ctx.page.keyboard.press("Backspace");

  await ctx.page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "red.png", mimeType: "image/png", buffer: solidPng(229, 72, 77) });
  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    !ctx.cap.http.some((h) => h.method === "POST" && h.url.includes("/api/attachments/upload/"))
  ) {
    await ctx.page.waitForTimeout(200);
  }
  await settle(ctx, 2000, 15_000);
  await ctx.shotAlways("attached");

  // Search in project, then open the hit: `searchContents`, then `readFile`.
  await ctx.page.keyboard.press("ControlOrMeta+Shift+F");
  await ctx.page.getByPlaceholder(/^Search in /).fill("greeting");
  await ctx.page.getByText("hello parity").first().waitFor({ timeout: 15_000 });
  await settle(ctx, 1500, 15_000);
  await ctx.shotAlways("content-search");
  await ctx.page.keyboard.press("Enter");
  await ctx.page.getByText("hello parity").first().waitFor({ timeout: 15_000 });
  await settle(ctx, 2000, 15_000);
  await ctx.shotAlways("file-open");
  await dump(ctx, "file-open");
}

const tsFiles = (ctx) => filesOn(ctx, false);
const rustFiles = (ctx) => filesOn(ctx, true);

/** True once the server sent a frame whose JSON contains `text`, after `from` lines. */
const sentOut = (ctx, text, from = 0) =>
  ctx.cap.lines.slice(from).some((l) => l.dir === "out" && JSON.stringify(l.frame).includes(text));

async function waitOut(ctx, text, from = 0, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!sentOut(ctx, text, from)) {
    if (Date.now() > deadline) throw new Error(`no server frame with ${JSON.stringify(text)}`);
    await ctx.page.waitForTimeout(100);
  }
}

async function waitRequest(ctx, tag, from = 0, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!ctx.cap.lines.slice(from).some((l) => l.dir === "in" && l.frame?.tag === tag)) {
    if (Date.now() > deadline) throw new Error(`the client never called ${tag}`);
    await ctx.page.waitForTimeout(100);
  }
}

/**
 * On a draft: opens the terminal drawer, runs `echo`, resizes the window, reloads the page
 * and checks the scrollback comes back, runs a busy command, then closes the terminal.
 * `memory(label)` samples the server at each step. The terminal draws on a canvas, so the
 * checks read the wire, and the screenshots show the screen.
 */
async function terminalFlow(ctx, memory) {
  const toggle = ctx.page.getByRole("button", { name: "Toggle terminal drawer" }).first();
  let from = ctx.cap.lines.length;
  await toggle.click();
  await waitRequest(ctx, "terminal.attach", from);
  await waitOut(ctx, '"type":"snapshot"', from);
  await settle(ctx, 1500, 15_000);
  memory("terminal-idle");
  from = ctx.cap.lines.length;
  await ctx.page.keyboard.type("echo conn-terminal-$((6*7))");
  await ctx.page.keyboard.press("Enter");
  await waitOut(ctx, "conn-terminal-42", from);
  await settle(ctx, 1000, 10_000);
  await ctx.shotAlways("terminal-echo");

  from = ctx.cap.lines.length;
  await ctx.page.setViewportSize({ width: 1100, height: 760 });
  await waitRequest(ctx, "terminal.resize", from);
  await settle(ctx, 1000, 10_000);
  await ctx.shotAlways("terminal-resized");

  from = ctx.cap.lines.length;
  await ctx.page.reload();
  // The drawer stays open across a reload; open it if this client does not keep it.
  await ctx.page
    .getByRole("button", { name: "Toggle terminal drawer" })
    .first()
    .waitFor({ timeout: 30_000 });
  if (
    !(await waitOut(ctx, '"type":"snapshot"', from, 8_000).then(
      () => true,
      () => false,
    ))
  ) {
    await ctx.page.getByRole("button", { name: "Toggle terminal drawer" }).first().click();
  }
  await waitOut(ctx, "conn-terminal-42", from);
  await settle(ctx, 1500, 15_000);
  await ctx.shotAlways("terminal-after-reload");

  from = ctx.cap.lines.length;
  let peak = {};
  await ctx.page.keyboard.type('yes | head -c 50000000; echo busy-""done');
  await ctx.page.keyboard.press("Enter");
  const deadline = Date.now() + 300_000;
  while (!sentOut(ctx, "busy-done", from)) {
    if (Date.now() > deadline) throw new Error("the busy command did not finish");
    peak = peakOf(peak, memory("terminal-busy", true));
    await ctx.page.waitForTimeout(250);
  }
  ctx.log(`memory KB peak while busy ${JSON.stringify(peak)}`);
  await settle(ctx, 2000, 30_000);
  // Keep the recording small: drop the flood's output chunks and the acks for them.
  const before = ctx.cap.lines.length;
  const kept = ctx.cap.lines.slice(from).filter((l) => {
    const text = JSON.stringify(l.frame);
    return !(
      l.frame?._tag === "Ack" ||
      (l.frame?._tag === "Chunk" && text.includes('"type":"output"') && !text.includes("busy-done"))
    );
  });
  ctx.cap.lines.splice(from, Infinity, ...kept);
  ctx.log(`dropped ${before - ctx.cap.lines.length} frames of busy output from the recording`);
  memory("terminal-after-busy");
  await ctx.shotAlways("terminal-busy-done");

  from = ctx.cap.lines.length;
  await ctx.page
    .getByRole("button", { name: /^Close Terminal/ })
    .first()
    .click();
  // The client may ask to confirm closing a terminal.
  const confirm = ctx.page.getByRole("button", { name: /^(Close|Close terminal|Confirm)$/ });
  await confirm
    .first()
    .waitFor({ timeout: 3_000 })
    .then(
      () => confirm.first().click(),
      () => {},
    );
  await waitRequest(ctx, "terminal.close", from);
  await settle(ctx, 1500, 15_000);
  memory("terminal-closed");
  await ctx.shotAlways("terminal-closed");
}

const peakOf = (a, b) =>
  Object.fromEntries(Object.keys(b).map((k) => [k, Math.max(a[k] ?? 0, b[k] ?? 0)]));

async function terminal(ctx) {
  await reconnect(ctx);
  await ctx.page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.pathname.startsWith("/draft/"), { timeout: 15_000 });
  await settle(ctx);
  ctx.memory(ctx.server, "connected");
  await terminalFlow(ctx, (label, quiet) => {
    const m = ctx.memory(ctx.server, label);
    if (!quiet) ctx.log(`memory KB ${label} ${JSON.stringify(m)}`);
    return m;
  });
}

async function rustTerminal(ctx) {
  const target = await pairRust(ctx);
  await ctx.page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await ctx.page.getByRole("dialog").getByText("rust-project", { exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.pathname.startsWith("/draft/"), { timeout: 15_000 });
  await settle(ctx);
  ctx.log(`memory KB connected ${JSON.stringify(ctx.memory(target, "connected"))}`);
  await terminalFlow(ctx, (label, quiet) => {
    const m = ctx.memory(target, label);
    if (!quiet) ctx.log(`memory KB ${label} ${JSON.stringify(m)}`);
    return m;
  });
}

/** True once the client sent a frame whose JSON contains `text`. */
const sentIn = (ctx, text) =>
  ctx.cap.lines.some((l) => l.dir === "in" && JSON.stringify(l.frame).includes(text));

/** An image upload that Claude reads and names the colour of. */
async function rustAttachment(ctx) {
  await pairRust(ctx);
  await rustHaikuDraft(ctx, null);
  await ctx.page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "red.png", mimeType: "image/png", buffer: solidPng(229, 72, 77) });
  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    !ctx.cap.http.some((h) => h.method === "POST" && h.url.includes("/api/attachments/upload/"))
  ) {
    await ctx.page.waitForTimeout(200);
  }
  await settle(ctx, 1500, 15_000);
  await send(ctx, "What colour fills this image? Reply with one lowercase word.");
  await waitTurnEnd(ctx);
  await ctx.page
    .getByText(/^red\.?$/i)
    .last()
    .waitFor({ timeout: 30_000 });
  await ctx.shotAlways("attachment-described");
}

/** A thread launched into a new git worktree from the composer's run context menu. */
async function rustWorktree(ctx) {
  await pairRust(ctx);
  await rustHaikuDraft(ctx, null);
  await ctx.page
    .getByRole("button", { name: /^Run context/ })
    .first()
    .click();
  await ctx.page
    .getByRole("menuitemradio", { name: /New worktree/ })
    .first()
    .click();
  await settle(ctx, 1000, 10_000);
  await ctx.shotAlways("worktree-mode");
  await send(ctx, "Reply with exactly: worktree ok");
  await waitTurnEnd(ctx);
  await ctx.page
    .getByText(/^(echo: Reply with exactly: )?worktree ok\.?$/i)
    .last()
    .waitFor({ timeout: 30_000 });
  if (!sentIn(ctx, '"workspaceStrategy":{"type":"worktree"')) {
    throw new Error("the client did not launch with a worktree strategy");
  }
  await ctx.shotAlways("worktree-turn");
}

/** A turn where Claude calls a T3 tool over /mcp. */
async function rustMcp(ctx) {
  await pairRust(ctx);
  await rustHaikuDraft(ctx, "Full access");
  await send(
    ctx,
    "Call the t3_thread_list tool of the t3-code MCP server once, then reply with exactly: mcp ok",
  );
  await waitTurnEnd(ctx, 180_000);
  await ctx.page
    .getByText(/^mcp ok\.?$/i)
    .last()
    .waitFor({ timeout: 30_000 });
  if (
    !ctx.cap.lines.some(
      (l) => l.dir === "out" && JSON.stringify(l.frame).includes("t3_thread_list"),
    )
  ) {
    throw new Error("no t3_thread_list tool row reached the client");
  }
  await ctx.shotAlways("mcp-tool");
}

/** A subagent turn; its row opens the child thread. */
async function rustSubagent(ctx) {
  await pairRust(ctx);
  await rustHaikuDraft(ctx, "Full access");
  await send(
    ctx,
    "Use the Agent tool with the description 'Echo check' to run the shell command `echo sub-ok` and report its output. Then reply with exactly: subagent ok",
  );
  // The user's own Claude settings may still ask for the subagent's command: approve it.
  const deadline = Date.now() + 240_000;
  await stopButton(ctx).first().waitFor({ state: "visible", timeout: 30_000 });
  while (Date.now() < deadline && (await stopButton(ctx).first().isVisible())) {
    const approve = ctx.page.getByRole("button", { name: "Approve", exact: true }).first();
    if (await approve.isVisible().catch(() => false)) {
      ctx.log("approving the subagent's command");
      await approve.click();
    }
    await ctx.page.waitForTimeout(500);
  }
  await settle(ctx, 4000, 60_000);
  await ctx.page
    .getByText(/subagent ok/i)
    .last()
    .waitFor({ timeout: 60_000 });
  await ctx.shotAlways("subagent-parent");
  const parentUrl = ctx.page.url();
  await ctx.page.getByText("Echo check", { exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.href !== parentUrl, { timeout: 15_000 });
  await settle(ctx, 2000, 15_000);
  if (!decodeURIComponent(ctx.page.url()).includes("thread:subagent:")) {
    throw new Error(`the row opened ${ctx.page.url()}, not a child thread`);
  }
  await ctx.shotAlways("subagent-child");
}

export const SCENARIOS = {
  pairing,
  reconnect,
  turn,
  permission,
  interrupt,
  remote,
  "rust-turn": rustTurn,
  "rust-load": rustLoad,
  "rust-restart": rustRestart,
  "rust-permission": rustPermission,
  "rust-stop": rustStop,
  settings: (ctx) => settingsAndAccess(ctx, false),
  "rust-settings": (ctx) => settingsAndAccess(ctx, true),
  "ts-follow-up": followUp.ts,
  "rust-follow-up": followUp.rust,
  "ts-queue": queued.ts,
  "rust-queue": queued.rust,
  "ts-search": search.ts,
  "rust-search": search.rust,
  vcs,
  "rust-vcs": rustVcs,
  "ts-files": tsFiles,
  "rust-files": rustFiles,
  terminal,
  "rust-terminal": rustTerminal,
  "rust-attachment": rustAttachment,
  "rust-worktree": rustWorktree,
  "rust-mcp": rustMcp,
  "rust-subagent": rustSubagent,
};
