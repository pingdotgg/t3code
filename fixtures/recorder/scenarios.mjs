import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
  const banner = ctx.page.getByText("conn-server is reconnecting");
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
};
