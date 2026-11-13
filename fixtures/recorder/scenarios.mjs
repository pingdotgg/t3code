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
  const target = await ctx.startRustServer();
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
async function rustHaikuDraft(ctx, runtimeLabel) {
  // "New thread" opens a project picker; the Rust environment's project is `rust-project`.
  await ctx.page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await ctx.page.getByRole("dialog").getByText("rust-project", { exact: true }).first().click();
  await ctx.page.waitForURL((u) => u.pathname.startsWith("/draft/"), { timeout: 15_000 });
  await ctx.page
    .getByText(/What should we build in\s*rust-project/)
    .first()
    // A hidden copy of the heading exists only for the draft's own project.
    .waitFor({ state: "attached", timeout: 15_000 });
  await ctx.page
    .getByRole("button", { name: /^Claude/ })
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

export const SCENARIOS = {
  pairing,
  reconnect,
  turn,
  permission,
  interrupt,
  remote,
  terminal,
  "rust-turn": rustTurn,
  "rust-load": rustLoad,
  "rust-restart": rustRestart,
  "rust-permission": rustPermission,
  "rust-stop": rustStop,
  "rust-terminal": rustTerminal,
};
