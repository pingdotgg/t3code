// @effect-diagnostics nodeBuiltinImport:off - one-shot MCP child process from Electron main, outside any Effect runtime.
// @effect-diagnostics globalTimers:off - polling waits in a plain async driver.
// @effect-diagnostics globalDate:off - wait deadlines in a plain async driver.
// @effect-diagnostics extendsNativeError:off - plain Promise helper, never in an Effect failure channel.
/**
 * Loads MT Code's unpacked Chrome extension by driving Chrome's own UI with
 * munim-computer-use, the way a person would: open chrome://extensions, turn
 * on Developer mode, press "Load unpacked" and pick the folder.
 *
 * Google Chrome no longer accepts `--load-extension`, refuses remote debugging
 * on the user's own profile, and only side-loads Web Store items, so going
 * through the UI is the one route that ends with the extension in the
 * browser the user is signed into.
 *
 * The parsing helpers are pure so they can be tested without Chrome.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

/** One interactive element of a get_app_state outline. */
export interface OutlineElement {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly value: string;
  readonly windowTitle: string;
  /** Empty where the platform prints no window ids (macOS). */
  readonly windowId: string;
  readonly focused: boolean;
  readonly disabled: boolean;
}

// Windows/Linux print `window_id=N` and `= "value"`; macOS prints neither id
// nor `=`, but `value="value"`.
const WINDOW_HEADER = /^──\s*window\s+\d+:\s+"((?:[^"\\]|\\.)*)"(?:\s+window_id=(\d+))?/;
const ELEMENT_LINE =
  /^\s*\[(e\d+)\]\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+(?:=\s*|value=)"((?:[^"\\]|\\.)*)")?/;

/** Parse a get_app_state outline into its elements, each tagged with its window. */
export function parseOutline(text: string): OutlineElement[] {
  const elements: OutlineElement[] = [];
  let windowTitle = "";
  let windowId = "";
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(WINDOW_HEADER);
    if (header) {
      windowTitle = header[1] ?? "";
      windowId = header[2] ?? "";
      continue;
    }
    const element = line.match(ELEMENT_LINE);
    if (element) {
      elements.push({
        id: element[1] ?? "",
        role: element[2] ?? "",
        label: element[3] ?? "",
        value: element[4] ?? "",
        windowTitle,
        windowId,
        focused: line.includes("(focused)"),
        disabled: line.includes("(disabled)"),
      });
    }
  }
  return elements;
}

/** One row of list_apps. */
export interface AppRow {
  readonly name: string;
  readonly pid: string;
  readonly windows: number;
  readonly windowTitle: string;
}

const APP_ROW =
  /^(.+?)\s{2,}\[[^\]]*\]\s+pid=(\d+)\s+windows=(\d+)(?:\s+window="((?:[^"\\]|\\.)*)")?/;

export function parseAppList(text: string): AppRow[] {
  const rows: AppRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(APP_ROW);
    if (!match) continue;
    rows.push({
      name: match[1]?.trim() ?? "",
      pid: match[2] ?? "",
      windows: Number(match[3] ?? 0),
      windowTitle: match[4] ?? "",
    });
  }
  return rows;
}

/** Title of Chrome's folder picker for "Load unpacked" (Windows and Linux). */
export const LOAD_UNPACKED_DIALOG_TITLE = "Select the extension directory.";

/**
 * The Chrome browser process: a "Google Chrome" instance with a window that is
 * not the folder picker (Windows hosts the picker in a utility process that
 * list_apps also names "Google Chrome").
 */
export function findBrowserPids(apps: readonly AppRow[]): string[] {
  return apps
    .filter(
      (row) =>
        row.name === "Google Chrome" &&
        row.windows > 0 &&
        row.windowTitle !== LOAD_UNPACKED_DIALOG_TITLE,
    )
    .map((row) => row.pid);
}

/** The process that owns the folder picker, when it is a window of its own. */
export function findDialogPid(apps: readonly AppRow[]): string | undefined {
  return apps.find((row) => row.windowTitle === LOAD_UNPACKED_DIALOG_TITLE)?.pid;
}

// ── MCP over stdio ──────────────────────────────────────────────────────────

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
}

export interface ComputerUseClient {
  readonly call: (tool: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  readonly close: () => void;
}

/** Start munim-computer-use as an MCP server and complete the handshake. */
export async function startComputerUseClient(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<ComputerUseClient> {
  const child = NodeChildProcess.spawn(binary, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let exited = false;
  let exitReason = "munim-computer-use is not running";
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
  });
  const failAll = (reason: string) => {
    exited = true;
    exitReason = stderrTail.trim() ? `${reason}: ${stderrTail.trim().slice(-500)}` : reason;
    for (const { reject } of pending.values()) reject(new Error(exitReason));
    pending.clear();
  };
  child.on("error", (error) => failAll(`munim-computer-use failed to start: ${error.message}`));
  child.on("exit", (code, signal) =>
    failAll(`munim-computer-use exited (${code ?? signal ?? "unknown"})`),
  );
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: number; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object) =>
    new Promise<unknown>((resolve, reject) => {
      if (exited) {
        reject(new Error(exitReason));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mtcode-chrome-extension-setup", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    call: async (tool, args = {}) => {
      const result = (await request("tools/call", { name: tool, arguments: args })) as {
        isError?: boolean;
        content?: ReadonlyArray<{ type?: string; text?: string }>;
      };
      const text = (result.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      return { isError: result.isError === true, text };
    },
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

// ── the drive ───────────────────────────────────────────────────────────────

export interface DriveOptions {
  readonly client: ComputerUseClient;
  readonly platform: NodeJS.Platform;
  /** Folder to load; Chrome remembers this path. */
  readonly extensionDir: string;
  readonly extensionId: string;
  /** Title of the page MT Code opened in a new Chrome window, to find that window. */
  readonly markerTitle: string;
  /**
   * macOS only: a client started with remote control on, whose keys go to the
   * real keyboard focus. The open panel runs in its own system process
   * (openAndSavePanelService), so keys addressed to Chrome never reach it.
   */
  readonly realKeys?: ComputerUseClient;
  readonly log?: (line: string) => void;
}

export class ChromeDriveError extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drive Chrome's extensions page to load `extensionDir`. Chrome must already
 * be showing the setup page in a window (its address bar carries
 * {@link SETUP_PAGE_TOKEN}, its title starts with `markerTitle`; see
 * {@link chromeSetupPageUrl}). Resolves once the page lists the extension id.
 */
export async function driveLoadUnpacked(options: DriveOptions): Promise<void> {
  const { client, platform, extensionDir, extensionId, markerTitle } = options;
  const log = options.log ?? (() => {});

  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await client.call(tool, args);
    log(
      `${tool} ${JSON.stringify(args)} -> ${result.isError ? "error: " : ""}${result.text.split("\n")[0]}`,
    );
    return result;
  };

  const isSetupOmnibox = (element: OutlineElement) =>
    /edit|text|combo|entry/i.test(element.role) &&
    (element.value.includes(SETUP_PAGE_TOKEN) || element.windowTitle.startsWith(markerTitle));

  /**
   * The Chrome process showing the setup page, and its address bar. More than
   * one process can be called Google Chrome (a second profile directory, the
   * Windows folder-picker host), so look in each. A cold start with a big
   * profile can take most of a minute.
   */
  const findSetupWindow = async (): Promise<{ app: string; omnibox: OutlineElement }> => {
    const deadline = Date.now() + 90_000;
    let sawChrome = false;
    while (Date.now() < deadline) {
      const pids = findBrowserPids(parseAppList((await client.call("list_apps")).text));
      sawChrome ||= pids.length > 0;
      for (const pid of pids) {
        const omnibox = await find(pid, "Address and search bar", isSetupOmnibox, 1);
        if (omnibox) return { app: pid, omnibox };
      }
      await sleep(1000);
    }
    throw new ChromeDriveError(
      sawChrome ? "could not find the setup window in Chrome" : "Chrome did not open a window",
    );
  };

  const find = async (
    app: string,
    query: string,
    match: (element: OutlineElement) => boolean,
    attempts = 15,
  ): Promise<OutlineElement | undefined> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = await client.call("get_app_state", { app, query });
      const hit = state.isError ? undefined : parseOutline(state.text).find(match);
      if (hit) return hit;
      if (attempt + 1 < attempts) await sleep(700);
    }
    return undefined;
  };

  const need = async (
    app: string,
    query: string,
    match: (element: OutlineElement) => boolean,
    what: string,
  ): Promise<OutlineElement> => {
    const hit = await find(app, query, match);
    if (!hit) throw new ChromeDriveError(`could not find ${what}`);
    return hit;
  };

  /** Re-read and click until the click lands: pages re-render while loading. */
  const clickFresh = async (
    app: string,
    query: string,
    match: (element: OutlineElement) => boolean,
    what: string,
  ) => {
    let lastError = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      const element = await need(app, query, match, what);
      const result = await call("click", { element_id: element.id });
      if (!result.isError) return;
      lastError = result.text;
      await sleep(700);
    }
    throw new ChromeDriveError(`could not click ${what}: ${lastError}`);
  };

  // 1. Our window, then chrome://extensions in it (Chrome ignores chrome://
  //    URLs passed on its command line, so go through the address bar).
  const { app, omnibox } = await findSetupWindow();
  log(`chrome pid ${app}`);
  // Navigating renames the window, so follow it by id where there is one.
  const windowId = omnibox.windowId;
  const inOurWindow = (element: OutlineElement) => !windowId || element.windowId === windowId;
  // Focus it first: set_value does not move focus, and Return goes to the focus.
  await call("click", { element_id: omnibox.id });
  const setUrl = await call("set_value", { element_id: omnibox.id, value: "chrome://extensions/" });
  if (setUrl.isError)
    throw new ChromeDriveError(`could not type into the address bar: ${setUrl.text}`);
  const go = await call("press_key", { key: "return" });
  if (go.isError) throw new ChromeDriveError(`could not open chrome://extensions: ${go.text}`);
  await sleep(1500);

  // 2. Developer mode reveals "Load unpacked".
  await need(
    app,
    "Developer mode",
    (element) => inOurWindow(element) && /developer mode/i.test(element.label),
    "the extensions page",
  );
  const isLoadUnpacked = (element: OutlineElement) =>
    inOurWindow(element) && /button/i.test(element.role) && /load unpacked/i.test(element.label);
  if (!(await find(app, "Load unpacked", isLoadUnpacked, 2))) {
    await clickFresh(
      app,
      "Developer mode",
      (element) =>
        inOurWindow(element) &&
        /button|toggle|checkbox|switch/i.test(element.role) &&
        /developer mode/i.test(element.label),
      "the Developer mode switch",
    );
  }
  await clickFresh(app, "Load unpacked", isLoadUnpacked, "Load unpacked");

  // 3. The folder picker.
  if (platform === "darwin") {
    if (!options.realKeys)
      throw new ChromeDriveError("the macOS folder picker needs real key input");
    const realKeys = options.realKeys;
    const pressReal = async (key: string, modifiers: string[] = []) => {
      const result = await realKeys.call("press_key", { key, modifiers });
      log(`real press_key ${[...modifiers, key].join("+")} -> ${result.text.split("\n")[0]}`);
      if (result.isError) throw new ChromeDriveError(`could not press ${key}: ${result.text}`);
    };
    await pickFolderMac(app, extensionDir, { call, find, clickFresh }, pressReal);
  } else {
    let dialogApp: string | undefined;
    for (let attempt = 0; attempt < 30 && !dialogApp; attempt++) {
      await sleep(500);
      const apps = parseAppList((await client.call("list_apps")).text);
      dialogApp = findDialogPid(apps);
      // Linux GTK pickers live in Chrome's own process.
      if (!dialogApp && platform === "linux") {
        const field = await find(
          app,
          "",
          (element) => element.windowTitle === LOAD_UNPACKED_DIALOG_TITLE,
          1,
        );
        if (field) dialogApp = app;
      }
    }
    if (!dialogApp) throw new ChromeDriveError("the folder picker did not open");
    if (platform === "win32") {
      await pickFolderWindows(dialogApp, extensionDir, { call, find, clickFresh });
    } else {
      await pickFolderLinux(dialogApp, extensionDir, { call, find, clickFresh });
    }
  }

  // 4. The page lists the extension card with its id.
  const card = await find(
    app,
    extensionId,
    (element) => element.label.includes(extensionId) || element.value.includes(extensionId),
    20,
  );
  if (!card) throw new ChromeDriveError("Chrome did not list the extension after loading it");
}

interface PickerTools {
  readonly call: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
  readonly find: (
    app: string,
    query: string,
    match: (element: OutlineElement) => boolean,
    attempts?: number,
  ) => Promise<OutlineElement | undefined>;
  readonly clickFresh: (
    app: string,
    query: string,
    match: (element: OutlineElement) => boolean,
    what: string,
  ) => Promise<void>;
}

/** Windows common folder dialog: type the path into "Folder:", press "Select Folder". */
async function pickFolderWindows(app: string, folder: string, tools: PickerTools) {
  const field = await tools.find(app, "Folder:", (e) => e.role === "Edit" && e.label === "Folder:");
  if (!field) throw new ChromeDriveError("could not find the folder field");
  const set = await tools.call("set_value", { element_id: field.id, value: folder });
  if (set.isError) throw new ChromeDriveError(`could not enter the folder: ${set.text}`);
  await tools.clickFresh(
    app,
    "Select Folder",
    (e) => /button/i.test(e.role) && e.label === "Select Folder",
    "Select Folder",
  );
}

const CONFIRM_BUTTON = /^_?(select|open|choose)$/i;

/**
 * macOS open panel (a sheet on the extensions window): Go to Folder needs real
 * keys (cmd-shift-G, then Return), the path goes in with set_value, and the
 * Select button takes an accessibility press.
 */
async function pickFolderMac(
  app: string,
  folder: string,
  tools: PickerTools,
  pressReal: (key: string, modifiers?: string[]) => Promise<void>,
) {
  const confirm = (e: OutlineElement) =>
    /button/i.test(e.role) && CONFIRM_BUTTON.test(e.label) && !e.disabled;
  const anyConfirm = (e: OutlineElement) => /button/i.test(e.role) && CONFIRM_BUTTON.test(e.label);
  // The sheet takes a few seconds to appear.
  if (!(await tools.find(app, "Select", anyConfirm, 20))) {
    throw new ChromeDriveError("the folder picker did not open");
  }
  // Real keys land in the key window of the frontmost app.
  await tools.call("activate_app", { app });
  await sleep(500);
  await pressReal("g", ["cmd", "shift"]);
  const field = await tools.find(
    app,
    "TextField",
    (e) => /text ?field|combo ?box/i.test(e.role) && e.focused,
    10,
  );
  if (!field) throw new ChromeDriveError("could not find the Go to Folder field");
  const set = await tools.call("set_value", { element_id: field.id, value: folder });
  if (set.isError) throw new ChromeDriveError(`could not enter the folder: ${set.text}`);
  await sleep(300);
  await pressReal("return");
  await sleep(1000);
  await tools.clickFresh(app, "Select", confirm, "the picker's Select button");
}

/** GTK file chooser: ctrl-L opens the location entry; enter the path, confirm. */
async function pickFolderLinux(app: string, folder: string, tools: PickerTools) {
  const inDialog = (e: OutlineElement) => e.windowTitle === LOAD_UNPACKED_DIALOG_TITLE;
  await tools.call("press_key", { key: "l", modifiers: ["ctrl"] });
  const field = await tools.find(
    app,
    "",
    (e) => inDialog(e) && /text|edit|entry/i.test(e.role) && !/search/i.test(e.label),
  );
  if (!field) throw new ChromeDriveError("could not find the location field");
  const path = folder.endsWith("/") ? folder : `${folder}/`;
  const set = await tools.call("set_value", { element_id: field.id, value: path });
  if (set.isError) {
    const typed = await tools.call("type_text", { element_id: field.id, text: path });
    if (typed.isError) throw new ChromeDriveError(`could not enter the folder: ${typed.text}`);
  }
  await tools.clickFresh(
    app,
    "",
    (e) => inDialog(e) && /button/i.test(e.role) && CONFIRM_BUTTON.test(e.label),
    "the picker's Select button",
  );
}

/** A page whose title marks the Chrome window MT Code opened for setup. */
export function chromeSetupPageUrl(markerTitle: string): string {
  // The token comes first and needs no escaping, so it shows verbatim at the
  // start of the address bar (long values are cut off at the end).
  const title = markerTitle.replace(/[^A-Za-z0-9 ]/g, "").replaceAll(" ", "%20");
  return `data:text/html,<!--${SETUP_PAGE_TOKEN}--><title>${title}</title><h3>${title}</h3>`;
}

/** Marks the address bar of the window MT Code opened (see {@link chromeSetupPageUrl}). */
export const SETUP_PAGE_TOKEN = "mtcode-extension-setup";
