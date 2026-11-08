import { assert, describe, it } from "@effect/vitest";

import {
  chromeSetupPageUrl,
  findBrowserPids,
  findDialogPid,
  parseAppList,
  parseOutline,
  SETUP_PAGE_TOKEN,
} from "./chromeExtensionDriver.ts";

// Captured from munim-computer-use 0.13.0 on Windows 11 with Chrome 157.
const LIST_APPS = `Application Frame Host  [application-frame-host]  pid=8544  windows=1
Google Chrome  [google-chrome]  pid=39620  windows=1  window="Select the extension directory."  FRONTMOST
Google Chrome  [google-chrome]  pid=39540  windows=1  window="Extensions - Google Chrome"
MT Code  [mt-code]  pid=35344  windows=2
note: 2 instances of Google Chrome are running (pids 39620, 39540); its name matches all of them, so pass the pid`;

const OMNIBOX_QUERY = `40804 (pid 40804), 2 window(s)
filter: "Address and search bar" — 2 matching elements

── window 0: "MT Code setup - Google Chrome"  window_id=33359706
                [e6] Edit "Address and search bar" = "data:text/html,<title>MT Code setup</title>"
── window 1: "Extensions - Google Chrome"  window_id=2755846
                [e24] Edit "Address and search bar" = "chrome://extensions"`;

const EXTENSIONS_PAGE = `── window 0: "Extensions - Google Chrome"  window_id=134613840
Window "Extensions - Google Chrome" (disabled)
              [e11] Document "Extensions" = "chrome://extensions/"
                  [e15] Text "Developer mode"
                  [e16] Button "Developer mode"
                  [e17] Button "Load unpacked"
                  [e25] Text "ID: kgdolgnijopbghhomnblabjkmjhnoage"
              [e31] Button "Tab search"`;

describe("chromeExtensionDriver parsing", () => {
  it("reads list_apps rows and skips notes", () => {
    const rows = parseAppList(LIST_APPS);
    assert.deepStrictEqual(
      rows.map((row) => [row.name, row.pid, row.windows, row.windowTitle]),
      [
        ["Application Frame Host", "8544", 1, ""],
        ["Google Chrome", "39620", 1, "Select the extension directory."],
        ["Google Chrome", "39540", 1, "Extensions - Google Chrome"],
        ["MT Code", "35344", 2, ""],
      ],
    );
  });

  it("tells the browser process from the folder picker's process", () => {
    const rows = parseAppList(LIST_APPS);
    assert.deepStrictEqual(findBrowserPids(rows), ["39540"]);
    assert.strictEqual(findDialogPid(rows), "39620");
  });

  it("falls back to any Chrome window when titles carry no suffix (macOS)", () => {
    const rows = parseAppList(
      `Google Chrome  [com.google.Chrome]  pid=501  windows=2  window="Extensions"`,
    );
    assert.deepStrictEqual(findBrowserPids(rows), ["501"]);
    assert.strictEqual(findDialogPid(rows), undefined);
  });

  it("lists every Chrome process with a window, e.g. a second profile directory", () => {
    const rows = parseAppList(`Google Chrome  [google-chrome]  pid=10  windows=3
Google Chrome  [google-chrome]  pid=20  windows=1`);
    assert.deepStrictEqual(findBrowserPids(rows), ["10", "20"]);
  });

  it("finds no browser while Chrome has no window yet", () => {
    assert.deepStrictEqual(
      findBrowserPids(parseAppList(`Google Chrome  [google-chrome]  pid=7  windows=0`)),
      [],
    );
  });

  it("tags each element with the window it is in", () => {
    const elements = parseOutline(OMNIBOX_QUERY);
    assert.deepStrictEqual(
      elements.map((element) => [element.id, element.role, element.windowTitle, element.windowId]),
      [
        ["e6", "Edit", "MT Code setup - Google Chrome", "33359706"],
        ["e24", "Edit", "Extensions - Google Chrome", "2755846"],
      ],
    );
    assert.strictEqual(elements[1]?.value, "chrome://extensions");
    assert.strictEqual(elements[0]?.label, "Address and search bar");
  });

  it("reads the macOS outline, which has no window ids and spells values value=", () => {
    const elements =
      parseOutline(`Google Chrome [com.google.Chrome] pid=71485 frontmost=false windows=1
filter: "Address and search bar" — 1 matching element

── window 0: "MT Code is adding its Chrome extension - Google Chrome"
                  [e6] TextField "Address and search bar" value="data:text/html,<!--mtcode-extension-setup--><title>MT%20Code…"`);
    assert.strictEqual(elements.length, 1);
    assert.strictEqual(elements[0]?.role, "TextField");
    assert.strictEqual(elements[0]?.windowId, "");
    assert.strictEqual(
      elements[0]?.windowTitle,
      "MT Code is adding its Chrome extension - Google Chrome",
    );
    assert.ok(elements[0]?.value.includes("mtcode-extension-setup"));
  });

  it("reads the extensions page controls and the installed id", () => {
    const elements = parseOutline(EXTENSIONS_PAGE);
    assert.ok(elements.some((e) => e.role === "Button" && e.label === "Load unpacked"));
    assert.ok(elements.some((e) => e.label.includes("kgdolgnijopbghhomnblabjkmjhnoage")));
  });

  it("builds a setup page whose address starts with the token", () => {
    const url = chromeSetupPageUrl("MT Code is adding its Chrome extension");
    assert.ok(url.startsWith(`data:text/html,<!--${SETUP_PAGE_TOKEN}-->`));
    assert.ok(url.includes("<title>MT%20Code%20is%20adding%20its%20Chrome%20extension</title>"));
    assert.ok(!url.includes(" "));
  });
});
