// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/chromeTabs.ts), modified for Ada.
// LocalRouter ported it from Sidebud (github.com/jayleaton/sidebud @70da540); both notices ship in LICENSE.localrouter.
import { array, boolean, nullable, number, object, optional, string } from "./validate.ts";
import { JXA_HELPERS, jxa, jxaRunner, macAccessError } from "./desktop.ts";
import type { CommandRunner } from "./macControls.ts";
import type { AutomationCheck, BrowserTab, BrowserTabs, TabGroup } from "./types.ts";

const BUNDLE_ID = "com.google.Chrome";
const SYSTEM_EVENTS = "com.apple.systemevents";

/**
 * Every running process of the browser's bundle. Several can share one bundle (a headless Chrome that Playwright
 * launched, a second profile), and addressing the browser by name reaches whichever process macOS picks, so one is
 * chosen by pid (`chooseInstance`). `frontWindow` is the rank of the process's first normal window on screen.
 */
const INSTANCES_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  var running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var frontPid = front && !front.isNil() ? front.processIdentifier : -1;
  var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  windows = windows.filter(function (w) { return w.kCGWindowLayer === 0; });
  var out = [];
  for (var i = 0; i < running.count; i++) {
    var app = running.objectAtIndex(i), pid = app.processIdentifier, rank = -1;
    for (var w = 0; w < windows.length && rank < 0; w++) if (windows[w].kCGWindowOwnerPID === pid) rank = w;
    out.push({ pid: pid, regular: Number(app.activationPolicy) === 0, frontmost: pid === frontPid, frontWindow: rank < 0 ? null : rank });
  }
  return JSON.stringify(out);
}`;
export type BrowserInstance = {
  pid: number;
  regular: boolean;
  frontmost: boolean;
  frontWindow: number | null;
};
const instancesSchema = {
  parse: (value: unknown): BrowserInstance[] =>
    array(value, "browser processes", (raw, what) => {
      const entry = object(raw, what);
      return {
        pid: number(entry.pid, `${what} pid`),
        regular: boolean(entry.regular, `${what} regular`),
        frontmost: boolean(entry.frontmost, `${what} frontmost`),
        frontWindow: nullable(entry.frontWindow, `${what} frontWindow`, number),
      };
    }),
};

/**
 * The process whose windows the user sees: the frontmost one, else the one with the frontmost window
 * on screen, else any regular app. Background-only processes (headless automation browsers) never qualify.
 */
export function chooseInstance(instances: BrowserInstance[]): BrowserInstance | null {
  const visible = instances.filter((instance) => instance.regular);
  const rank = (instance: BrowserInstance) =>
    instance.frontmost ? -1 : (instance.frontWindow ?? Number.MAX_SAFE_INTEGER);
  return visible.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** The tab strip's tab buttons in one window, in order. */
const TAB_BUTTONS = `
function tabButtons(win) {
  var queue = [{ el: win, depth: 0 }], found = [], visited = 0;
  while (queue.length && visited < 1500) {
    var node = queue.shift(), kids = children(node.el);
    for (var i = 0; i < kids.length; i++) {
      visited++;
      var role = plain(kids[i], 'AXRole');
      if (role === 'AXRadioButton' && plain(kids[i], 'AXSubrole') === 'AXTabButton') found.push(kids[i]);
      else if (role !== 'AXWebArea' && node.depth < 12) queue.push({ el: kids[i], depth: node.depth + 1 });
    }
  }
  return found;
}
function tabTitle(button) { return String(plain(button, 'AXTitle') || plain(button, 'AXDescription') || ''); }
`;

/**
 * Apple Events addressed to one process id. osascript's `Application(…)` cannot do this (by pid it is
 * refused), so the object specifiers are built by hand: `get <prop> of every tab of every window`.
 * Batched property reads return every window's values in one event, which keeps listing fast.
 */
const APPLE_EVENTS = `
function fourcc(s) { return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0; }
var AED = $.NSAppleEventDescriptor;
function specifier(want, form, seld, from) {
  var record = AED.recordDescriptor;
  record.setDescriptorForKeyword(AED.descriptorWithTypeCode(fourcc(want)), fourcc('want'));
  record.setDescriptorForKeyword(AED.descriptorWithEnumCode(fourcc(form)), fourcc('form'));
  record.setDescriptorForKeyword(seld, fourcc('seld'));
  record.setDescriptorForKeyword(from || AED.nullDescriptor, fourcc('from'));
  return record.coerceToDescriptorType(fourcc('obj '));
}
function every(cls, from) { return specifier(cls, 'indx', AED.descriptorWithDescriptorTypeData(fourcc('abso'), AED.descriptorWithTypeCode(fourcc('all ')).data), from); }
function property(code, from) { return specifier('prop', 'prop', AED.descriptorWithTypeCode(fourcc(code)), from); }
function unpack(d) {
  if (!d || d.isNil()) return null;
  if (d.descriptorType === fourcc('list')) { var out = []; for (var i = 1; i <= d.numberOfItems; i++) out.push(unpack(d.descriptorAtIndex(i))); return out; }
  if (d.descriptorType === fourcc('long') || d.descriptorType === fourcc('shor')) return d.int32Value;
  return ObjC.unwrap(d.stringValue);
}
function getFrom(pid, target) {
  var event = AED.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(fourcc('core'), fourcc('getd'), AED.descriptorWithProcessIdentifier(pid), -1, 0);
  event.setParamDescriptorForKeyword(target, fourcc('----'));
  var error = Ref(), reply = event.sendEventWithOptionsTimeoutError(3, 5, error);
  if (!reply || reply.isNil()) throw new Error('Apple Event failed (' + (error[0] ? error[0].code : '?') + ')');
  var code = reply.paramDescriptorForKeyword(fourcc('errn'));
  if (code && !code.isNil() && code.int32Value !== 0) throw new Error('Apple Event refused (' + code.int32Value + ')');
  return unpack(reply.paramDescriptorForKeyword(fourcc('----'))) || [];
}
`;

/**
 * One process's tabs. Scripting gives titles and addresses; when that process refuses Apple Events
 * (Automation not allowed), or macOS has not given its OK yet ("ax": no Apple Event is sent at all, since
 * one would open macOS's "wants to control Google Chrome" prompt), the tab strip's titles are read through
 * accessibility instead, without addresses. argv: pid, "events" | "ax".
 */
const LIST_SCRIPT = `${JXA_HELPERS}${TAB_BUTTONS}${APPLE_EVENTS}
function run(argv) {
  var pid = Number(argv[0]), tabs = [];
  if (argv[1] !== 'ax') {
    try {
      var windows = every('cwin', null), all = every('CrTb', windows);
      var titles = getFrom(pid, property('pnam', all)), urls = getFrom(pid, property('URL ', all)), active = getFrom(pid, property('acTI', windows));
      for (var w = 0; w < titles.length; w++) {
        for (var t = 0; t < titles[w].length; t++) {
          tabs.push({ window: w, index: t, title: titles[w][t] || '', url: (urls[w] || [])[t] || '', active: active[w] === t + 1 });
        }
      }
      return JSON.stringify(tabs);
    } catch (scriptingRefused) {
      tabs = [];
    }
  }
  trusted();
  var list = attr(axApp(pid), 'AXWindows');
  for (var v = 0; list && v < list.count; v++) {
    tabButtons(list.objectAtIndex(v)).forEach(function (button, t) {
      tabs.push({ window: v, index: t, title: tabTitle(button), url: '', active: plain(button, 'AXValue') === 1 });
    });
  }
  return JSON.stringify(tabs);
}`;
const tabsSchema = {
  parse: (value: unknown): BrowserTab[] =>
    array(value, "tabs", (raw, what) => {
      const tab = object(raw, what);
      return {
        window: number(tab.window, `${what} window`),
        index: number(tab.index, `${what} index`),
        title: string(tab.title, `${what} title`),
        url: string(tab.url, `${what} url`),
        active: boolean(tab.active, `${what} active`),
      };
    }),
};

/**
 * Switches tabs the way a person does: brings that process forward, raises the window holding the tab, and clicks the
 * tab's button with the real pointer. Chrome's accessibility titles add suffixes (" – Pinned", " - Memory usage"), so
 * a tab matches when its title starts with the listed one; every window is searched. argv: pid, title, index, dryrun.
 */
const ACTIVATE_SCRIPT = `${JXA_HELPERS}${TAB_BUTTONS}
function run(argv) {
  var pid = Number(argv[0]), title = argv[1], index = Number(argv[2]), dryrun = argv[3] === 'dryrun', press = argv[3] === 'press';
  trusted();
  var app = axApp(pid);
  var windows = attr(app, 'AXWindows'), exact = null, loose = null;
  function matches(button) { return tabTitle(button).indexOf(title) === 0; }
  for (var w = 0; windows && w < windows.count && !exact; w++) {
    var win = windows.objectAtIndex(w), buttons = tabButtons(win);
    if (buttons[index] && matches(buttons[index])) exact = { win: win, button: buttons[index] };
    for (var b = 0; title && !loose && b < buttons.length; b++) if (matches(buttons[b])) loose = { win: win, button: buttons[b] };
  }
  var hit = exact || loose;
  if (!hit) throw new Error('ADA_NO_TAB');
  if (!dryrun) {
    $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid).activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    $.AXUIElementPerformAction(hit.win, $('AXRaise'));
    delay(0.3);
  }
  if (press) {
    if ($.AXUIElementPerformAction(hit.button, $('AXPress')) !== 0) throw new Error('ADA_NO_PRESS');
    return JSON.stringify({ pressed: true });
  }
  var point = center(hit.button);
  if (!point) throw new Error('ADA_NO_TAB');
  clickAt(point, dryrun);
  return JSON.stringify({ x: point[0], y: point[1] });
}`;

/**
 * When the browser answers neither scripting nor accessibility, a tab is found with its own tab search: the name,
 * Return and Escape go to its process as key events, and nothing is typed unless the panel opened. The panel comes
 * from Chrome's menu; ⇧⌘A through System Events only with "events". argv: pid, name, "events" | "none". Returns
 * { before, after, opened, matched?, blocked? }.
 */
const SEARCH_SCRIPT = `${JXA_HELPERS}
function own(pid) {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  return list.filter(function (w) { return w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0; });
}
// Real windows only: Chrome (or a screen-sharing app) can keep small windows in the same layer (a 66×20
// one over the tab strip on 2026-09-26), and reading one of those made every search look like it failed.
function real(w) { return w.kCGWindowBounds.Width >= 200 && w.kCGWindowBounds.Height >= 150; }
function title(pid, skip) { var main = own(pid).filter(function (w) { return real(w) && w.kCGWindowNumber !== skip; })[0]; return main ? String(main.kCGWindowName || '') : ''; }
function openSearch(pid, events) {
  try { if (menuCommand(axApp(pid), 'A', 1)) return true; } catch (error) { /* Chrome refuses accessibility: the shortcut */ }
  if (!events) return false;
  Application('System Events').keystroke('a', { using: ['command down', 'shift down'] });
  return true;
}
function run(argv) {
  var pid = Number(argv[0]), name = argv[1], events = argv[2] !== 'none';
  var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!running || running.isNil()) throw new Error('ADA_NO_CHROME');
  running.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
  for (var i = 0; i < 20 && $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !== pid; i++) delay(0.05);
  if ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !== pid) throw new Error('ADA_NOT_FRONT');
  var before = title(pid, -1), known = own(pid).map(function (w) { return w.kCGWindowNumber; });
  if (!openSearch(pid, events)) return JSON.stringify({ before: before, after: before, opened: false, blocked: true });
  // The panel is a new real window of this process; the first open after Chrome comes forward can take
  // over a second.
  var panel = null;
  for (var j = 0; j < 30 && !panel; j++) {
    delay(0.1);
    panel = own(pid).filter(function (w) { return real(w) && known.indexOf(w.kCGWindowNumber) < 0; })[0] || null;
  }
  if (!panel) return JSON.stringify({ before: before, after: before, opened: false });
  delay(0.2);
  typeText(pid, name, false);
  delay(0.6);
  keyToPid(pid, 36);
  delay(0.6);
  var still = own(pid).some(function (w) { return w.kCGWindowNumber === panel.kCGWindowNumber; });
  var after = title(pid, panel.kCGWindowNumber);
  // Nothing matched: the panel is still open, so Escape closes it.
  if (still) keyToPid(pid, 53);
  return JSON.stringify({ before: before, after: after, opened: true, matched: !still });
}`;
type SearchResult = {
  before: string;
  after: string;
  opened: boolean;
  matched?: boolean;
  blocked?: boolean;
};
const searchSchema = {
  parse: (value: unknown): SearchResult => {
    const result = object(value, "tab search");
    const matched = optional(result.matched, "tab search matched", boolean);
    const blocked = optional(result.blocked, "tab search blocked", boolean);
    return {
      before: string(result.before, "tab search before"),
      after: string(result.after, "tab search after"),
      opened: boolean(result.opened, "tab search opened"),
      ...(matched === undefined ? {} : { matched }),
      ...(blocked ? { blocked } : {}),
    };
  },
};

/**
 * Tab groups from the tab strip, in order: a group's header (any strip item that is not a tab, with a
 * name) comes before its tabs, which run until the next header. Read-only. argv: pid.
 */
const GROUPS_SCRIPT = `${JXA_HELPERS}
function run(argv) {
  var app = axApp(Number(argv[0]));
  var windows = attr(app, 'AXWindows'), groups = [];
  for (var w = 0; windows && w < windows.count; w++) {
    var queue = [{ el: windows.objectAtIndex(w), depth: 0 }], visited = 0, strip = null;
    while (queue.length && visited < 1500 && !strip) {
      var node = queue.shift(), kids = children(node.el);
      for (var i = 0; i < kids.length; i++) {
        visited++;
        if (plain(kids[i], 'AXSubrole') === 'AXTabButton') { strip = node.el; break; }
        if (plain(kids[i], 'AXRole') !== 'AXWebArea' && node.depth < 12) queue.push({ el: kids[i], depth: node.depth + 1 });
      }
    }
    if (!strip) continue;
    var current = null;
    children(strip).forEach(function (item) {
      var name = String(plain(item, 'AXTitle') || plain(item, 'AXDescription') || '');
      if (plain(item, 'AXSubrole') === 'AXTabButton') { if (current) current.tabs.push(name); }
      else if (name) { current = { name: name, tabs: [] }; groups.push(current); }
    });
  }
  return JSON.stringify(groups.filter(function (group) { return group.tabs.length; }));
}`;
const groupsSchema = {
  parse: (value: unknown): TabGroup[] =>
    array(value, "tab groups", (raw, what) => {
      const group = object(raw, what);
      return {
        name: string(group.name, `${what} name`),
        tabs: array(group.tabs, `${what} tabs`, string),
      };
    }),
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `automation`: macOS's Automation grants, checked without asking; absent, Apple Events are sent as before. */
export type ChromeTabsOptions = { automation?: AutomationCheck };

/**
 * Google Chrome's tabs, from the Chrome process on screen (never launching Chrome), and switching by
 * clicking the tab strip, or by Chrome's tab search when that process cannot be read. With `automation`, an Apple
 * Event goes to Chrome (or System Events) only when macOS already allowed it: otherwise the tabs are read from the
 * tab strip through accessibility, so no "wants to control" prompt ever opens during a task.
 */
export class ChromeTabs implements BrowserTabs {
  readonly browser = "Google Chrome";

  private readonly runner: CommandRunner;
  private readonly automation: AutomationCheck | null;

  constructor(runner: CommandRunner = jxaRunner, options: ChromeTabsOptions = {}) {
    this.runner = runner;
    this.automation = options.automation ?? null;
  }

  /** Whether Apple Events may go to that app now: always without a check, else only with macOS's OK already given. */
  private async may(bundleId: string): Promise<boolean> {
    return !this.automation || (await this.automation.allowed(bundleId).catch(() => false));
  }

  /** The on-screen Chrome process, or null when no Chrome window can be on screen. */
  async instance(): Promise<BrowserInstance | null> {
    return chooseInstance(
      instancesSchema.parse(
        JSON.parse((await this.runner.run(...jxa(INSTANCES_SCRIPT, [BUNDLE_ID]))).trim() || "[]"),
      ),
    );
  }

  async list(): Promise<BrowserTab[]> {
    const target = await this.instance();
    if (!target) return [];
    try {
      const mode = (await this.may(BUNDLE_ID)) ? "events" : "ax";
      return tabsSchema.parse(
        JSON.parse(
          (await this.runner.run(...jxa(LIST_SCRIPT, [String(target.pid), mode]))).trim() || "[]",
        ),
      );
    } catch (error) {
      throw macAccessError(messageOf(error)) ?? error;
    }
  }

  async groups(): Promise<TabGroup[]> {
    const target = await this.instance();
    if (!target) return [];
    try {
      return groupsSchema.parse(
        JSON.parse(
          (await this.runner.run(...jxa(GROUPS_SCRIPT, [String(target.pid)]))).trim() || "[]",
        ),
      );
    } catch (error) {
      throw macAccessError(messageOf(error)) ?? error;
    }
  }

  async activate(tab: BrowserTab): Promise<void> {
    await this.switchTo(tab, "click");
  }

  async press(tab: BrowserTab): Promise<void> {
    await this.switchTo(tab, "press");
  }

  private async switchTo(tab: BrowserTab, how: "click" | "press"): Promise<void> {
    const target = await this.instance();
    if (!target) throw new Error("Google Chrome is not open.");
    try {
      await this.runner.run(
        ...jxa(ACTIVATE_SCRIPT, [String(target.pid), tab.title, String(tab.index), how]),
      );
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("ADA_NO_PRESS"))
        throw new Error("Chrome would not switch to that tab without the mouse.", { cause: error });
      if (message.includes("ADA_NO_TAB"))
        throw new Error("Could not find that tab in Chrome's tab strip.", { cause: error });
      throw macAccessError(message) ?? error;
    }
  }

  /**
   * Switches to the tab Chrome's own tab search finds first for `name`. Returns the title now in front,
   * or null when the search found nothing (the tab in front did not change).
   */
  async search(name: string): Promise<string | null> {
    const target = await this.instance();
    if (!target) throw new Error("Google Chrome is not open.");
    let result: SearchResult;
    try {
      const mode = (await this.may(SYSTEM_EVENTS)) ? "events" : "none";
      result = searchSchema.parse(
        JSON.parse(
          (await this.runner.run(...jxa(SEARCH_SCRIPT, [String(target.pid), name, mode]))).trim(),
        ),
      );
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("ADA_NOT_FRONT"))
        throw new Error("Google Chrome did not come to the front.", { cause: error });
      if (message.includes("ADA_NO_CHROME"))
        throw new Error("Google Chrome is not open.", { cause: error });
      throw macAccessError(message) ?? error;
    }
    if (result.blocked)
      throw new Error(
        "Chrome's tab search could not be opened: Chrome is not answering accessibility, and pressing its shortcut needs macOS's OK for Ada to control System Events, which Ada never asks for during a task. Allow it in Ada's settings before starting a task.",
      );
    if (!result.opened) throw new Error("Chrome's tab search did not open.");
    // The panel closing on Return means a tab was chosen; the front window's title is then that tab's.
    if (result.matched === false) return null;
    return result.matched ||
      result.after !== result.before ||
      result.after.toLowerCase().includes(name.toLowerCase())
      ? result.after
      : null;
  }
}

/** Every script this backend runs, by name: the tests parse each one, as osascript would. */
export const SCRIPTS = {
  instances: INSTANCES_SCRIPT,
  list: LIST_SCRIPT,
  activate: ACTIVATE_SCRIPT,
  search: SEARCH_SCRIPT,
  groups: GROUPS_SCRIPT,
};
