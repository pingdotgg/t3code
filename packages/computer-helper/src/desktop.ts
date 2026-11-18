// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/desktop.ts), modified for Ada.
// LocalRouter ported it from Sidebud (github.com/jayleaton/sidebud @70da540); both notices ship in LICENSE.localrouter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  array,
  boolean,
  json,
  nullable,
  number,
  object,
  oneOf,
  optional,
  string,
} from "./validate.ts";
import { execRunner } from "./runner.ts";
import type { CommandOptions, CommandRunner } from "./runner.ts";
import { CONTROL_ROLES, fitScale, NeedsPointer, SCREENSHOT_MAX_EDGE } from "./types.ts";
import type {
  ActOptions,
  ActResult,
  AutomationCheck,
  Observation,
  ObserveOptions,
  Point,
  PointerReading,
  Rect,
  ScreenAction,
  ScreenBackend,
  ScreenControl,
  Screenshot,
  ScreenshotOptions,
} from "./types.ts";

/**
 * Default runner for the computer-use backends. osascript prints the script's return value on
 * stdout; on failure only stderr is kept, because execFile's own message repeats the whole script
 * and the error patterns below would otherwise match the script source instead of the real error.
 * A stop (`signal`) kills the script under way.
 */
export const jxaRunner: CommandRunner = execRunner({
  timeoutMs: 15_000,
  maxBuffer: 16 * 1024 * 1024,
  slow: "The Mac (osascript)",
});

const READ_STDIN_ARGV =
  "JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding)) || '[]')";

/**
 * The source osascript runs for a JXA script whose `run(argv)` receives `argv`: the script's own
 * `run` is called with the values read from stdin, so typed text, labels and URLs never sit in a
 * process listing the way argv does.
 */
export function jxaSource(script: string): string {
  return `var adaRun = (function () {\n${script}\nreturn run;\n})();\nfunction run() { return adaRun(${READ_STDIN_ARGV}); }`;
}

/** The osascript call for `script` with `argv` on stdin; `options` adds a stop signal or a deadline. */
export function jxa(
  script: string,
  argv: string[] = [],
  options: Omit<CommandOptions, "input"> = {},
): [string, string[], CommandOptions] {
  return [
    "osascript",
    ["-l", "JavaScript", "-e", jxaSource(script)],
    { ...options, input: JSON.stringify(argv) },
  ];
}

/**
 * JXA helpers shared by the desktop scripts and Chrome tab switching. Reads use the AXUIElement C API through the
 * ObjC bridge rather than System Events, which costs one Apple Event per property; out-params use `Ref()` and the
 * result goes through `ObjC.castRefToObject`. AX positions are global top-left-origin points, the space CGEvent
 * uses, so an element's center is clicked directly. `dryrun` builds events without posting them.
 */
export const JXA_HELPERS = `
ObjC.import('ApplicationServices');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function attr(el, name) {
  var ref = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), ref) !== 0) return null;
  return ObjC.castRefToObject(ref[0]);
}
function plain(el, name) {
  var value = attr(el, name);
  if (value == null) return null;
  try { var unwrapped = ObjC.unwrap(value); return typeof unwrapped === 'object' ? null : unwrapped; } catch (error) { return null; }
}
function pair(el, name) {
  var value = attr(el, name);
  if (value == null) return null;
  var match = ObjC.unwrap(value.description).match(/(?:x|w):(-?[\\d.]+) (?:y|h):(-?[\\d.]+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}
function children(el) {
  var list = attr(el, 'AXChildren'), out = [];
  if (!list) return out;
  for (var i = 0; i < list.count; i++) out.push(list.objectAtIndex(i));
  return out;
}
// The items of a menu the app has open (a context menu), wherever it hangs: off the app, or inside a window's chrome
// (Chrome's). The menu bar and the page itself are not searched.
var MENU_PATH = { AXWindow: 1, AXGroup: 1, AXScrollArea: 1, AXMenu: 1, AXMenuItem: 1 };
// Chrome's autofill and saved-password rows are pressable static texts in a popup window, not menu items.
function popupRows(app, label) {
  var wins = attr(app, 'AXWindows'), found = [];
  for (var i = 0; wins && i < wins.count && !found.length; i++) {
    var w = wins.objectAtIndex(i), sub = plain(w, 'AXSubrole');
    if (sub === 'AXStandardWindow' || sub === 'AXDialog') continue;
    var queue = [w], seen = 0;
    while (queue.length && seen < 200 && !found.length) {
      var kids = children(queue.shift());
      for (var j = 0; j < kids.length; j++, seen++) {
        var el = kids[j];
        if (plain(el, 'AXRole') === 'AXStaticText' && String(plain(el, 'AXValue') || '').replace(/\\s+/g, ' ').trim() === label) { found.push(el); break; }
        queue.push(el);
      }
    }
  }
  return found;
}
function openMenuItems(app) {
  var queue = children(app).filter(function (el) { return plain(el, 'AXRole') !== 'AXMenuBar'; });
  var items = [], seen = 0;
  while (queue.length && seen < 1500) {
    var el = queue.shift(); seen++;
    var role = plain(el, 'AXRole');
    if (role === 'AXMenuItem' && plain(el, 'AXTitle')) items.push(el);
    if (MENU_PATH[role]) queue = queue.concat(children(el));
  }
  return items;
}
function center(el) {
  var p = pair(el, 'AXPosition'), s = pair(el, 'AXSize');
  return p && s && s[0] > 0 && s[1] > 0 ? [p[0] + s[0] / 2, p[1] + s[1] / 2] : null;
}
// The app macOS asks about for Accessibility: the one that launched the helper (Terminal, iTerm),
// which marks its child processes with its bundle ID. Under the LaunchAgent nothing marks it, and
// macOS asks about the node binary itself (empty here).
function hostApp() {
  var env = $.NSProcessInfo.processInfo.environment, id = env.objectForKey('__CFBundleIdentifier');
  var url = id && !id.isNil() ? $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id) : null;
  if (url && !url.isNil()) return ObjC.unwrap(url.URLByDeletingPathExtension.lastPathComponent);
  var term = env.objectForKey('TERM_PROGRAM');
  return term && !term.isNil() ? ObjC.unwrap(term).replace(/^Apple_/, '').replace(/\\.app$/, '') : '';
}
function trusted() {
  if (!$.AXIsProcessTrusted()) throw new Error('ADA_NO_ACCESSIBILITY:' + hostApp() + ':');
}
// The AX root of one app process. With Accessibility granted, an app can still refuse every request
// (kAXErrorAPIDisabled / CannotComplete): the app asks macOS whether the caller is trusted, and macOS
// refuses when it cannot identify the app itself, as when the program file it runs from was deleted
// while it was open (on 2026-09-26 a disk cleanup removed the owner's Chrome's code-sign clone). That
// is reported as the app's refusal, not as a missing control or a missing permission.
// A hung app answers every AX call only after the messaging timeout (6 s by default), so a walk of a few hundred
// elements would outlast the script's own limit: 1.5 s an answer, and the walk keeps its own time budget too.
function axApp(pid) {
  var app = $.AXUIElementCreateApplication(pid), ref = Ref();
  $.AXUIElementSetMessagingTimeout(app, 1.5);
  var code = $.AXUIElementCopyAttributeValue(app, $('AXRole'), ref);
  if (code === -25211 || code === -25204) {
    var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    throw new Error('ADA_UNREACHABLE:' + (running && !running.isNil() ? ObjC.unwrap(running.localizedName) : 'The app') + ':');
  }
  return app;
}
// Every display's bounds in global top-left-origin points. NSScreen frames have a bottom-left origin at the
// main display (the first screen, with the menu bar), so y is flipped against its height.
function displays() {
  var screens = $.NSScreen.screens, out = [];
  if (!screens.count) return out;
  var mainHeight = screens.objectAtIndex(0).frame.size.height;
  for (var i = 0; i < screens.count; i++) {
    var f = screens.objectAtIndex(i).frame;
    out.push({ x: f.origin.x, y: mainHeight - f.origin.y - f.size.height, w: f.size.width, h: f.size.height });
  }
  return out;
}
// A click outside every display would land on the nearest edge instead (CGEvent clamps it): never clicked.
function onScreen(point) {
  var list = displays();
  if (!list.length) return true;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (point[0] >= d.x && point[0] < d.x + d.w && point[1] >= d.y && point[1] < d.y + d.h) return true;
  }
  return false;
}
function post(event, dryrun) { if (!dryrun) $.CGEventPost($.kCGHIDEventTap, event); }
// The process id of a running app by its localized name, for events sent to that process (not the global tap).
function pidOf(name) {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) { var a = apps.objectAtIndex(i); if (ObjC.unwrap(a.localizedName) === name) return a.processIdentifier; }
  return $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
}
// Posts an event to one process, so the person's own pointer and keyboard (the global tap) are untouched. A zero pid
// falls back to the HID tap; CGEventPostToPid needs a real pid.
function postToPid(pid, event, dryrun) { if (dryrun) return; if (pid > 0) $.CGEventPostToPid(pid, event); else $.CGEventPost($.kCGHIDEventTap, event); }
function keyToPid(pid, code, flags) {
  var down = $.CGEventCreateKeyboardEvent($(), code, true), up = $.CGEventCreateKeyboardEvent($(), code, false);
  if (flags) { $.CGEventSetFlags(down, flags); $.CGEventSetFlags(up, flags); }
  postToPid(pid, down, false); postToPid(pid, up, false);
}
// Text typed as Unicode keyboard events to one process (CGEventKeyboardSetUnicodeString), never as a keystroke Apple
// Event: macOS never asks to let Ada control another app in the middle of a task, and the keyboard layout
// does not matter. At most 20 UTF-16 units an event (the event system cuts longer strings), never
// splitting a surrogate pair; no modifier flags, so a key the person holds down does not turn the text into shortcuts.
function typeText(pid, text, dryrun) {
  var at = 0;
  while (at < text.length) {
    var end = Math.min(text.length, at + 20);
    if (end < text.length && /[\\ud800-\\udbff]/.test(text.charAt(end - 1))) end -= 1;
    var part = $(text.slice(at, end)), count = end - at, units = $.NSMutableData.dataWithLength(count * 2);
    part.getCharactersRange(units.mutableBytes, $.NSMakeRange(0, count));
    [true, false].forEach(function (down) {
      var event = $.CGEventCreateKeyboardEvent($(), 0, down);
      $.CGEventSetFlags(event, 0);
      $.CGEventKeyboardSetUnicodeString(event, count, units.mutableBytes);
      postToPid(pid, event, dryrun);
    });
    if (!dryrun) delay(0.02);
    at = end;
  }
}
// The app's own menu item for a Command shortcut (Edit › Select All is ⌘A, Paste ⌘V; ⇧⌘ is modifiers 1), pressed
// through accessibility. Unlike a key code, this does not depend on the keyboard layout: key code 0 with Command is ⌘A
// on a US layout but ⌘Q (quit) on AZERTY.
function menuCommand(app, letter, modifiers) {
  var bar = attr(app, 'AXMenuBar');
  if (!bar) return false;
  var menus = children(bar);
  for (var i = 0; i < menus.length; i++) {
    var lists = children(menus[i]);
    for (var j = 0; j < lists.length; j++) {
      var items = children(lists[j]);
      for (var k = 0; k < items.length && k < 80; k++) {
        if (String(plain(items[k], 'AXMenuItemCmdChar') || '').toUpperCase() === letter && plain(items[k], 'AXMenuItemCmdModifiers') === (modifiers || 0) && plain(items[k], 'AXEnabled') !== false) {
          return $.AXUIElementPerformAction(items[k], $('AXPress')) === 0;
        }
      }
    }
  }
  return false;
}
function mouse(type, point, dryrun) {
  var event = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(point[0], point[1]), $.kCGMouseButtonLeft);
  $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, 1);
  post(event, dryrun);
}
// Moves the real pointer onto the point first so hover-dependent controls are ready for the click.
function clickAt(point, dryrun) {
  if (!onScreen(point)) throw new Error('ADA_OFFSCREEN');
  mouse($.kCGEventMouseMoved, point, dryrun);
  if (!dryrun) delay(0.08);
  mouse($.kCGEventLeftMouseDown, point, dryrun);
  mouse($.kCGEventLeftMouseUp, point, dryrun);
}
`;

// The main window is used rather than "window 1" because apps often keep small floating panels
// (input-method badges, palettes) ahead of the real window in the accessibility order.
const RUNNING = `
function runningNamed(name) {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) { var a = apps.objectAtIndex(i); if (ObjC.unwrap(a.localizedName) === name) return a; }
  throw new Error('ADA_NO_APP_NAMED:' + name + ':');
}
`;

/** `front(name)`: a running app read where it is, without bringing it forward. */
const FRONT = `${RUNNING}
function front(name) {
  trusted();
  var running = name ? runningNamed(name) : $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!running || running.isNil()) throw new Error('ADA_NO_APP');
  var app = axApp(running.processIdentifier);
  var win = attr(app, 'AXMainWindow') || attr(app, 'AXFocusedWindow');
  if (!win) { var windows = attr(app, 'AXWindows'); win = windows && windows.count ? windows.objectAtIndex(0) : null; }
  return { name: ObjC.unwrap(running.localizedName) || '', win: win, app: app };
}
`;

const OBSERVE_SCRIPT = `${JXA_HELPERS}${FRONT}
var ROLES = {
  AXButton: 'button', AXLink: 'link', AXTextField: 'textbox', AXTextArea: 'textbox', AXComboBox: 'textbox',
  AXSearchField: 'textbox', AXRadioButton: 'tab', AXTab: 'tab', AXRow: 'row', AXCell: 'row', AXMenuItem: 'menuitem',
  AXMenuButton: 'button', AXPopUpButton: 'button', AXCheckBox: 'checkbox'
};
var LEAVES = { AXStaticText: 1, AXImage: 1, AXTextField: 1, AXTextArea: 1, AXSearchField: 1, AXButton: 1, AXMenuButton: 1,
  AXPopUpButton: 1, AXCheckBox: 1, AXRadioButton: 1, AXScrollBar: 1, AXValueIndicator: 1, AXComboBox: 1 };
function clip(text, max) {
  text = String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '\\u2026' : text;
}
// Table rows rarely carry their own title; their label is the text of their cells.
function innerText(el, depth) {
  var out = '', kids = children(el);
  for (var i = 0; i < kids.length && out.length < 100; i++) {
    var text = plain(kids[i], 'AXRole') === 'AXStaticText' ? plain(kids[i], 'AXValue') : depth < 3 ? innerText(kids[i], depth + 1) : '';
    if (text) out += (out ? ' ' : '') + text;
  }
  return out;
}
// The page a browser window shows: the URL of its web area (Safari, Chrome, Electron), else the window's document.
function urlOf(el) {
  var value = attr(el, 'AXURL');
  if (value == null) return '';
  try { return ObjC.unwrap(value.absoluteString) || ''; } catch (error) { return ''; }
}
var WALK_MS = 4000;
// Web pages nest deep: Apple's sign-in frame puts its fields 33 levels under Chrome's window. The node and time budgets bound the walk.
var MAX_DEPTH = 64;
var LOADER = /(^|[-_\\s])(load|loader|loading|spinner|progress)([-_\\s]|$)/i;
// A page still loading shows it: a progress or busy indicator, a busy element, or a visible loader (Apple's sign-in
// keeps a full-page "maison-loader-spinner" up until its form's frame arrives, while the page reports itself loaded).
// A popup the app opened over its window (autofill suggestions, a menu) is a window of its own; its lines, the
// highlighted one marked.
function popupText(app) {
  var wins = attr(app, 'AXWindows'), lines = [];
  for (var i = 0; wins && i < wins.count; i++) {
    var w = wins.objectAtIndex(i), sub = plain(w, 'AXSubrole'), s = pair(w, 'AXSize');
    if (sub === 'AXStandardWindow' || sub === 'AXDialog' || !s || s[0] < 100 || s[1] < 30) continue;
    var queue = [w], seen = 0;
    while (queue.length && seen < 200) {
      var kids = children(queue.shift());
      for (var j = 0; j < kids.length; j++, seen++) {
        var el = kids[j], role = plain(el, 'AXRole');
        var words = role === 'AXStaticText' ? plain(el, 'AXValue') : role === 'AXList' || role === 'AXMenu' ? plain(el, 'AXTitle') : role === 'AXMenuItem' ? plain(el, 'AXTitle') : '';
        words = clip(words, 120);
        if (words && plain(el, 'AXSelected') === true) words = '\u25b8 ' + words;
        if (words && lines.indexOf(words) < 0 && lines.indexOf('\u25b8 ' + words) < 0) lines.push(words);
        queue.push(el);
      }
    }
  }
  return clip(lines.join(' | '), 400);
}
function showsLoading(el, role) {
  if (role === 'AXProgressIndicator' || role === 'AXBusyIndicator') return true;
  if (role !== 'AXGroup' && role !== 'AXWebArea') return false;
  return plain(el, 'AXElementBusy') === true || LOADER.test(plain(el, 'AXDOMIdentifier') || '');
}
function run(argv) {
  var target = front(argv && argv[0]);
  if (!target.win) return JSON.stringify({ app: target.name, title: '', controls: [], text: '' });
  var win = target.win, started = Date.now(), truncated = false, loading = false;
  var wp = pair(win, 'AXPosition'), ws = pair(win, 'AXSize');
  var left = wp[0], top = wp[1], right = wp[0] + ws[0], bottom = wp[1] + ws[1];
  var queue = [{ el: win, path: [], depth: 0 }], visited = 0, controls = [], text = '', url = '';
  while (queue.length) {
    if (visited >= 2500 || controls.length >= 150 || Date.now() - started > WALK_MS) { truncated = true; break; }
    var node = queue.shift(), kids = children(node.el);
    for (var i = 0; i < kids.length; i++) {
      if (visited >= 2500 || controls.length >= 150) { truncated = true; break; }
      visited++;
      var el = kids[i], role = plain(el, 'AXRole'), p = pair(el, 'AXPosition'), s = pair(el, 'AXSize');
      var sized = p && s && s[0] > 0 && s[1] > 0;
      if (sized && (p[0] >= right || p[1] >= bottom || p[0] + s[0] <= left || p[1] + s[1] <= top)) continue;
      var path = node.path.concat([i]);
      if (role === 'AXWebArea' && !url) url = urlOf(el);
      if (!loading && sized && showsLoading(el, role)) loading = true;
      if (role === 'AXStaticText') {
        var words = plain(el, 'AXValue');
        if (text.length < 1500 && words) text += (text ? ' ' : '') + clip(words, 1500);
      } else if (ROLES[role] && sized) {
        // A password field (subrole AXSecureTextField) is listed so it can be typed into, never with its value.
        var kind = ROLES[role], value = plain(el, 'AXSubrole') === 'AXSecureTextField' ? '' : plain(el, 'AXValue');
        var label = plain(el, 'AXTitle') || plain(el, 'AXDescription') || (kind === 'textbox' ? '' : value) ||
          (kind === 'row' ? innerText(el, 0) : '') ||
          (plain(el, 'AXSubrole') ? plain(el, 'AXRoleDescription') : '') || plain(el, 'AXHelp') || '';
        label = clip(label, 100);
        if (kind !== 'row' || label) {
          var control = { ref: path.join('.'), role: kind, label: label, bounds: { x: p[0], y: p[1], w: s[0], h: s[1] } };
          if (kind === 'textbox') {
            control.value = clip(value, 200);
            if (plain(el, 'AXFocused') === true) control.focused = true;
          }
          controls.push(control);
        }
      }
      if (!LEAVES[role] && node.depth + 1 < MAX_DEPTH) queue.push({ el: el, path: path, depth: node.depth + 1 });
    }
  }
  if (!url) { var doc = plain(win, 'AXDocument'); if (typeof doc === 'string' && /^(https?|file):/.test(doc)) url = doc; }
  controls.sort(function (a, b) { return Math.round(a.bounds.y / 8) - Math.round(b.bounds.y / 8) || a.bounds.x - b.bounds.x; });
  var out = { app: target.name, title: plain(win, 'AXTitle') || '', controls: controls, text: text.slice(0, 1500), window: { x: left, y: top, w: ws[0], h: ws[1] } };
  if (url) out.url = url;
  if (truncated) out.truncated = true;
  if (loading) out.loading = true;
  var popup = [popupText(target.app)].concat(openMenuItems(target.app).filter(function (item) { return plain(item, 'AXEnabled') !== false; }).map(function (item) { return clip(plain(item, 'AXTitle'), 80); })).filter(function (line) { return line; }).join(' | ').slice(0, 600);
  if (popup) out.popup = popup;
  return JSON.stringify(out);
}`;

/**
 * The frontmost app's front window from the window server's list, which needs no accessibility: its
 * id, bounds (global, top-left-origin points, the space clicks use), and title (the title needs Screen
 * Recording access, which is also what a screenshot of it needs).
 */
const WINDOW_LIST = `
function frontWindow(name) {
  var running = name ? runningNamed(name) : $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!running || running.isNil()) throw new Error('ADA_NO_APP');
  var pid = running.processIdentifier;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  // The frontmost real window, not a small helper window the app keeps in the same layer (Chrome has a
  // 66×20 one over its tab strip): a screenshot of that shows nothing to read.
  var win = list.filter(function (w) { return w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width >= 200 && w.kCGWindowBounds.Height >= 150; })[0];
  var b = win && win.kCGWindowBounds;
  return { app: ObjC.unwrap(running.localizedName) || '', window: win ? { id: win.kCGWindowNumber, x: b.X, y: b.Y, w: b.Width, h: b.Height, title: String(win.kCGWindowName || '') } : null };
}
`;

/**
 * One action on the frontmost main window, always through the real pointer and keyboard. The ref is
 * re-resolved here so the click lands where the control is now, not where observe() saw it. A ref
 * "v:x,y" is a spot read from a screenshot (the app refused accessibility), clicked where it was seen.
 */
const ACT_SCRIPT = `${JXA_HELPERS}${FRONT}${WINDOW_LIST}
function resolve(win, ref) {
  var el = win, parts = String(ref).split('.');
  for (var i = 0; i < parts.length; i++) {
    var kids = children(el), index = Number(parts[i]);
    if (!(index >= 0) || index >= kids.length) throw new Error('ADA_GONE');
    el = kids[index];
  }
  return el;
}
// The window's middle, from accessibility when the app answers, else from the window list.
function middleOfWindow() {
  try {
    var target = front();
    if (!target.win) throw new Error('ADA_NO_WINDOW');
    return center(target.win);
  } catch (error) {
    if (String(error.message).indexOf('ADA_UNREACHABLE') < 0) throw error;
    var seen = frontWindow().window;
    if (!seen) throw new Error('ADA_NO_WINDOW');
    return [seen.x + seen.w / 2, seen.y + seen.h / 2];
  }
}
var TEXT_ROLES = { AXTextField: 1, AXTextArea: 1, AXComboBox: 1, AXSearchField: 1 };
// Controls whose AXPress is the click a person makes: pressed through accessibility, the pointer and the app in front
// stay as they are (no pointer movement). Fields are focused (focusInPlace); the rest needs the person's mouse.
var PRESS_ROLES = { AXButton: 1, AXLink: 1, AXCheckBox: 1, AXRadioButton: 1, AXMenuItem: 1, AXMenuButton: 1, AXPopUpButton: 1 };
function pressable(el) {
  if (!PRESS_ROLES[plain(el, 'AXRole')]) return false;
  var ref = Ref();
  if ($.AXUIElementCopyActionNames(el, ref) !== 0) return false;
  var names = ObjC.castRefToObject(ref[0]);
  for (var i = 0; names && i < names.count; i++) if (ObjC.unwrap(names.objectAtIndex(i)) === 'AXPress') return true;
  return false;
}
// A click on a text field, or on any control whose AXFocused can be set, is what a click there does: it takes the
// focus. Set through accessibility, so the pointer stays where the person left it (Chrome's omnibox has no AXPress).
function focusable(el) {
  if (TEXT_ROLES[plain(el, 'AXRole')]) return true;
  var settable = Ref();
  return $.AXUIElementIsAttributeSettable(el, $('AXFocused'), settable) === 0 && (settable[0] === true || settable[0] === 1);
}
function focusInPlace(el) {
  if (!focusable(el)) return false;
  if ($.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true)) !== 0) return false;
  return true;
}
// The scroll view a person would scroll: the largest scroll or web area inside the window (not a sidebar), else null.
function scrollArea(win) {
  var queue = [{ el: win, depth: 0 }], seen = 0, best = null, bestArea = 0;
  while (queue.length && seen < 400) {
    var node = queue.shift(), kids = children(node.el);
    for (var i = 0; i < kids.length && seen < 400; i++) {
      seen++;
      var el = kids[i], role = plain(el, 'AXRole');
      if (role === 'AXScrollArea' || role === 'AXWebArea') {
        var s = pair(el, 'AXSize'), area = s ? s[0] * s[1] : 0;
        if (area > bestArea) { best = el; bestArea = area; }
      }
      if (node.depth + 1 < 10 && role !== 'AXWebArea') queue.push({ el: el, depth: node.depth + 1 });
    }
  }
  return best ? center(best) : null;
}
// Whether the text box took the typing focus after the click: the app's focused element is it, or sits inside it
// (a combo box's own field), and is a text element.
// The control under a screen point, only when it belongs to the app in front (never the overlay or another app).
function elementAt(point) {
  var found = Ref(), pid = Ref();
  if ($.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), point[0], point[1], found) !== 0) return null;
  var el = ObjC.castRefToObject(found[0]);
  if ($.AXUIElementGetPid(el, pid) !== 0) return null;
  return pid[0] === $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier ? el : null;
}
function hasFocus(app, el) {
  var focused = attr(app, 'AXFocusedUIElement');
  if (!focused) return false;
  if (!TEXT_ROLES[plain(focused, 'AXRole')] && plain(el, 'AXFocused') !== true) return false;
  var c = center(focused), p = pair(el, 'AXPosition'), s = pair(el, 'AXSize');
  return Boolean(c && p && s && c[0] >= p[0] - 2 && c[0] <= p[0] + s[0] + 2 && c[1] >= p[1] - 2 && c[1] <= p[1] + s[1] + 2);
}
// A Command shortcut by its character, through the app's menu item only. An app without one is told as it is: a
// keystroke Apple Event would make macOS ask for permission to control another app in the middle of a task.
// \`events\`: macOS already lets Ada send System Events key strokes (checked without asking), so the keystroke
// that maps the character to the key on the current layout is still used where the app has no menu item.
function command(app, letter, events) {
  if (menuCommand(app, letter)) return;
  if (events) return void Application('System Events').keystroke(letter.toLowerCase(), { using: 'command down' });
  throw new Error('ADA_NO_MENU_COMMAND:' + letter + ':');
}
// Pastes text through the pasteboard, marked transient and concealed so clipboard managers do not keep it, then
// puts back what the pasteboard held. For text the keyboard cannot type as is (other scripts, emoji, line breaks).
function paste(app, text, events) {
  var pb = $.NSPasteboard.generalPasteboard, saved = [], items = pb.pasteboardItems;
  for (var i = 0; items && i < items.count; i++) {
    var item = items.objectAtIndex(i), types = item.types, entries = [];
    for (var j = 0; j < types.count; j++) {
      var type = types.objectAtIndex(j), data = item.dataForType(type);
      if (data && !data.isNil()) entries.push([type, data]);
    }
    saved.push(entries);
  }
  pb.clearContents;
  var mine = $.NSPasteboardItem.alloc.init;
  mine.setStringForType($(text), $.NSPasteboardTypeString);
  mine.setStringForType($(''), $('org.nspasteboard.TransientType'));
  mine.setStringForType($(''), $('org.nspasteboard.ConcealedType'));
  pb.writeObjects($([mine]));
  try {
    command(app, 'V', events);
    delay(0.5);
  } finally {
    pb.clearContents;
    var back = saved.map(function (entries) {
      var it = $.NSPasteboardItem.alloc.init;
      entries.forEach(function (entry) { it.setDataForType(entry[1], entry[0]); });
      return it;
    });
    if (back.length) pb.writeObjects($(back));
  }
}
function run(argv) {
  var op = argv[0], payload = JSON.parse(argv[1] || '{}'), dryrun = payload.dryrun === true;
  trusted();
  if (op === 'press') {
    // A key to the app's own process (CGEventPostToPid), not the global tap, so the person's keyboard is untouched. A
    // Command shortcut is the app's own menu item first, which does not depend on the keyboard layout.
    var app = front();
    if (dryrun) return JSON.stringify({ mode: 'background' });
    var keyPid = app.name ? pidOf(app.name) : 0;
    if (!payload.command) keyToPid(keyPid, payload.code);
    else if (menuCommand(app.app, payload.command, 0)) return JSON.stringify({ mode: 'background', how: 'the app menu item' });
    else keyToPid(keyPid, payload.code, $.kCGEventFlagMaskCommand);
    return JSON.stringify({ mode: 'background' });
  }
  if (op === 'scroll') {
    var target = null;
    if (payload.ref) {
      var w = front().win;
      if (!w) throw new Error('ADA_NO_WINDOW');
      target = center(resolve(w, payload.ref));
      if (!target) throw new Error('ADA_GONE');
    } else {
      try { var fw = front().win; target = fw ? scrollArea(fw) : null; } catch (error) { target = null; }
      target = target || middleOfWindow();
    }
    if (!target) throw new Error('ADA_NO_WINDOW');
    if (!onScreen(target)) throw new Error('ADA_OFFSCREEN');
    var up = payload.direction === 'up' || payload.direction === 'top';
    var steps = payload.direction === 'top' || payload.direction === 'bottom' ? 20 : 3;
    // Scroll wheel events to the window's process, at the scroll area: the person's pointer is not moved.
    var spid = 0; try { spid = pidOf(front().app); } catch (e) { spid = 0; }
    for (var n = 0; n < steps; n++) { var ev = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, up ? 15 : -15); $.CGEventSetLocation(ev, $.CGPointMake(target[0], target[1])); postToPid(spid, ev, dryrun); }
    return JSON.stringify({ mode: 'background', at: { x: target[0], y: target[1] } });
  }
  if (op === 'setvalue') {
    var box = resolve(front().win, payload.ref);
    // AXValue set directly on the field (no keyboard): a native field and Chrome's omnibox take it; others do not.
    if (dryrun) return JSON.stringify({ mode: 'background' });
    if ($.AXUIElementSetAttributeValue(box, $('AXValue'), $(payload.text)) !== 0) throw new Error('ADA_NEEDS_POINTER:this field does not accept text without the keyboard:');
    return JSON.stringify({ mode: 'background' });
  }
  if (op === 'keys') {
    if (/[\\r\\n]/.test(payload.text)) throw new Error('ADA_NEWLINE');
    // System Events' keystroke only where macOS already allows it (checked without asking, payload.events); else to the
    // process in front (the field 'focus' just clicked into), as Unicode key events: no Apple Event, so no prompt.
    if (payload.events === true) { if (!dryrun) Application('System Events').keystroke(payload.text); }
    else typeText($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, String(payload.text), dryrun);
    return JSON.stringify({ mode: 'pointer' });
  }
  if (op === 'menu') {
    var owner = front();
    if (!owner.win) throw new Error('ADA_NO_WINDOW');
    var menuOf = resolve(owner.win, payload.ref), menuAt = center(menuOf);
    if (!dryrun && $.AXUIElementPerformAction(menuOf, $('AXShowMenu')) !== 0) throw new Error('ADA_NEEDS_POINTER:that control has no menu:');
    return JSON.stringify(menuAt ? { mode: 'background', at: { x: menuAt[0], y: menuAt[1] } } : { mode: 'background' });
  }
  if (op === 'pick') {
    var items = openMenuItems(front().app).filter(function (item) { return plain(item, 'AXTitle') === payload.label; });
    if (!items.length) items = popupRows(front().app, payload.label);
    if (!items.length) throw new Error('ADA_GONE');
    if (!dryrun && $.AXUIElementPerformAction(items[0], $('AXPress')) !== 0) throw new Error('ADA_GONE');
    return JSON.stringify({ mode: 'background', how: 'the menu item' });
  }
  var spot = /^v:(-?[\\d.]+),(-?[\\d.]+)$/.exec(String(payload.ref || '')), point, el = null, ax = null;
  if (spot) {
    point = [Number(spot[1]), Number(spot[2])];
    if (op === 'click') el = elementAt(point);
  } else {
    var here = front();
    if (!here.win) throw new Error('ADA_NO_WINDOW');
    ax = here.app;
    el = resolve(here.win, payload.ref);
    point = center(el);
  }
  if (op === 'value') return JSON.stringify({ value: el && plain(el, 'AXSubrole') !== 'AXSecureTextField' ? plain(el, 'AXValue') : null });
  if (op === 'paste') {
    if (!dryrun) paste(ax || front().app, payload.text, payload.events === true);
    return 'ok';
  }
  if (op === 'click') {
    var at = point ? { x: point[0], y: point[1] } : null;
    if (el && pressable(el)) { if (dryrun || $.AXUIElementPerformAction(el, $('AXPress')) === 0) return JSON.stringify({ mode: 'background', at: at }); }
    if (el && (dryrun ? focusable(el) : focusInPlace(el))) {
      // A button or link that offers no AXPress (a cross-site frame's) is activated the keyboard's way once focused.
      var elRole = plain(el, 'AXRole');
      if (!PRESS_ROLES[elRole] || dryrun) return JSON.stringify({ mode: 'background', at: at, how: 'focused through accessibility' });
      var link = elRole === 'AXLink';
      delay(0.05);
      keyToPid(pidOf(here ? here.name : ''), link ? 36 : 49);
      return JSON.stringify({ mode: 'background', at: at, how: 'focused, then pressed ' + (link ? 'Return' : 'Space') });
    }
    if (payload.allow !== true) throw new Error('ADA_NEEDS_POINTER:that control has no accessible action:');
    if (!point) throw new Error('ADA_GONE');
    clickAt(point, dryrun);
    return JSON.stringify({ mode: 'pointer', pointer: { x: point[0], y: point[1] }, at: { x: point[0], y: point[1] } });
  }
  if (!point) throw new Error('ADA_GONE');
  var left = { x: point[0], y: point[1] };
  if (op === 'focus') {
    if (dryrun || !el) return JSON.stringify({ mode: 'pointer', pointer: left, at: left });
    clickAt(point, dryrun);
    delay(0.15);
    if (!hasFocus(ax, el)) {
      $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true));
      delay(0.1);
      if (!hasFocus(ax, el)) throw new Error('ADA_NOT_FOCUSED');
    }
    // The text it holds is selected (to be replaced) only when there is any.
    var current = plain(el, 'AXValue');
    if (typeof current === 'string' && current.length) command(ax, 'A', payload.events === true);
    return JSON.stringify({ mode: 'pointer', pointer: left, at: left });
  }
  throw new Error('ADA_UNKNOWN_OP');
}`;

const FRONT_WINDOW_SCRIPT = `ObjC.import('AppKit');
ObjC.import('CoreGraphics');
${RUNNING}${WINDOW_LIST}
function run(argv) { return JSON.stringify(frontWindow(argv && argv[0])); }`;

type Window = { id: number; x: number; y: number; w: number; h: number; title: string };
type FrontWindow = { app: string; window: Window | null };

function frontWindowShape(value: unknown): FrontWindow {
  const front = object(value, "front window");
  return {
    app: string(front.app, "front window app"),
    window: nullable(front.window, "front window", (raw, what) => {
      const win = object(raw, what);
      return {
        id: number(win.id, `${what} id`),
        x: number(win.x, `${what} x`),
        y: number(win.y, `${what} y`),
        w: number(win.w, `${what} w`),
        h: number(win.h, `${what} h`),
        title: string(win.title, `${what} title`),
      };
    }),
  };
}

/**
 * On-device text recognition (Vision) of a screenshot: each line of text with its box, normalized to
 * the image with a bottom-left origin. argv: the image's path.
 */
const OCR_SCRIPT = `ObjC.import('Vision');
ObjC.import('Foundation');
function run(argv) {
  var request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0;
  request.usesLanguageCorrection = true;
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  if (!handler.performRequestsError($([request]), Ref())) throw new Error('ADA_OCR_FAILED');
  var results = request.results, out = [];
  for (var i = 0; results && i < results.count; i++) {
    var line = results.objectAtIndex(i), box = line.boundingBox, best = line.topCandidates(1).firstObject;
    if (best && !best.isNil()) out.push({ text: ObjC.unwrap(best.string), x: box.origin.x, y: box.origin.y, w: box.size.width, h: box.size.height });
  }
  return JSON.stringify(out);
}`;
export type OcrLine = { text: string; x: number; y: number; w: number; h: number };

function ocrShape(value: unknown): OcrLine[] {
  return array(value, "text lines", (raw, what) => {
    const line = object(raw, what);
    return {
      text: string(line.text, `${what} text`),
      x: number(line.x, `${what} x`),
      y: number(line.y, `${what} y`),
      w: number(line.w, `${what} w`),
      h: number(line.h, `${what} h`),
    };
  });
}

/**
 * Text read from a screenshot of the window, as clickable spots ("v:x,y" at each line's middle, in
 * the global points clicks use), top to bottom, then left to right.
 */
export function visualControls(lines: OcrLine[], window: Window): ScreenControl[] {
  return lines
    .filter((line) => /[a-z0-9]/i.test(line.text) && line.text.trim().length > 1)
    .map((line) => ({
      label: line.text.trim().slice(0, 100),
      x: Math.round(window.x + (line.x + line.w / 2) * window.w),
      y: Math.round(window.y + (1 - line.y - line.h / 2) * window.h),
    }))
    .sort((a, b) => Math.round(a.y / 8) - Math.round(b.y / 8) || a.x - b.x)
    .slice(0, 150)
    .map(({ label, x, y }) => ({ ref: `v:${x},${y}`, role: "text" as const, label }));
}

/** macOS virtual key codes for the keys a step may press (ANSI positions for the shortcut letters). */
const KEY_CODES = {
  enter: 36,
  escape: 53,
  tab: 48,
  space: 49,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  "cmd+l": 37,
  "cmd+t": 17,
  "cmd+w": 13,
} as const;

/** The JSON handed to the act script as argv: key codes for presses, otherwise the action's own fields. */
function actionPayload(action: ScreenAction): object {
  if (action.kind === "press")
    return action.key.startsWith("cmd+")
      ? { code: KEY_CODES[action.key], command: action.key.slice(4).toUpperCase() }
      : { code: KEY_CODES[action.key] };
  if (action.kind === "scroll")
    return action.ref
      ? { direction: action.direction, ref: action.ref }
      : { direction: action.direction };
  if (action.kind === "type") return { ref: action.ref, text: action.text };
  if (action.kind === "pick") return { label: action.label };
  return { ref: action.ref };
}

// -1743 is the separate Automation refusal (permission to send Apple Events to another app; the computer-use path
// sends none to System Events, so this comes from an older helper or Chrome's tab search). A refusal from the one app
// being read (ADA_UNREACHABLE) is not a missing permission: Accessibility is on, and that app has to be reopened.
const AUTOMATION = /-1743|Not authorized to send Apple events/i;
const ACCESSIBILITY = /ADA_NO_ACCESSIBILITY|-1719|assistive access|not allowed/i;
export const UNREACHABLE = /ADA_UNREACHABLE:([^:]+):/;

/** The app macOS asks about in Privacy & Security: the one running the helper, named by the script when it can. */
function hostFrom(message: string) {
  return (
    message.match(/ADA_NO_ACCESSIBILITY:([^:]+):/)?.[1]?.trim() ||
    "the node binary that runs Ada (for example /opt/homebrew/bin/node)"
  );
}

/** Turns an access failure from a script into an error that says which app and which setting to change. */
export function macAccessError(message: string): Error | null {
  const unreachable = message.match(UNREACHABLE);
  if (unreachable) {
    const app = (unreachable[1] ?? "").trim();
    return new Error(
      `${app} is refusing to show its window to other apps: macOS can no longer verify the running ${app} (a file it runs from was changed or removed while it was open). Quitting and reopening ${app} fixes this.`,
    );
  }
  if (AUTOMATION.test(message)) {
    return new Error(
      "Ada needs permission to control System Events. Allow the node binary that runs it under System Settings › Privacy & Security › Automation, then try again.",
    );
  }
  if (ACCESSIBILITY.test(message)) {
    return new Error(
      `Ada needs Accessibility access to see and use apps. Allow ${hostFrom(message)} in System Settings › Privacy & Security › Accessibility, then try again.`,
    );
  }
  return null;
}

// Screen Recording is only needed for the screenshot fallback (apps that refuse accessibility). Its check
// is guarded: should the bridge not expose it, Accessibility is still reported.
const ACCESS_SCRIPT = `${JXA_HELPERS}
function run() {
  var screen = false;
  try { screen = Boolean($.CGPreflightScreenCaptureAccess()); } catch (error) { screen = false; }
  return JSON.stringify({ accessibility: Boolean($.AXIsProcessTrusted()), screenRecording: screen, host: hostApp() });
}`;

export type MacAccess = { accessibility: boolean; screenRecording: boolean; host: string };

/** Whether the process running the helper has Accessibility and Screen Recording access, and the app macOS attributes it to. */
export async function macAccess(runner: CommandRunner = jxaRunner): Promise<MacAccess> {
  const access = object(
    json((await runner.run(...jxa(ACCESS_SCRIPT))).trim(), "access check"),
    "access check",
  );
  return {
    accessibility: boolean(access.accessibility, "accessibility"),
    screenRecording: boolean(access.screenRecording, "screenRecording"),
    host: string(access.host, "host"),
  };
}

/**
 * Where the pointer is now (global, top-left-origin points) and how long ago the left button last went down, without
 * moving it or needing any permission.
 */
const POINTER_SCRIPT = `ObjC.import('CoreGraphics');
function run() {
  var point = $.CGEventGetLocation($.CGEventCreate($()));
  var click = $.CGEventSourceSecondsSinceLastEventType($.kCGEventSourceStateHIDSystemState, $.kCGEventLeftMouseDown);
  return JSON.stringify({ x: point.x, y: point.y, since_click_s: click });
}`;

/** A point printed by a script (`{"x":1,"y":2}`). */
export function pointShape(value: unknown, what = "point"): Point {
  const point = object(value, what);
  return { x: number(point.x, `${what} x`), y: number(point.y, `${what} y`) };
}

function rectShape(value: unknown, what: string): Rect {
  const raw = object(value, what);
  return {
    x: number(raw.x, `${what} x`),
    y: number(raw.y, `${what} y`),
    w: number(raw.w, `${what} w`),
    h: number(raw.h, `${what} h`),
  };
}

function controlShape(value: unknown, what: string): ScreenControl {
  const raw = object(value, what);
  const control: ScreenControl = {
    ref: string(raw.ref, `${what} ref`),
    role: oneOf(raw.role, CONTROL_ROLES, `${what} role`),
    label: string(raw.label, `${what} label`),
  };
  const text = optional(raw.value, `${what} value`, string);
  const focused = optional(raw.focused, `${what} focused`, boolean);
  const bounds = optional(raw.bounds, `${what} bounds`, rectShape);
  if (text !== undefined) control.value = text;
  if (focused !== undefined) control.focused = focused;
  if (bounds !== undefined) control.bounds = bounds;
  return control;
}

function observationShape(value: unknown): Omit<Observation, "backend"> {
  const raw = object(value, "observation");
  const seen: Omit<Observation, "backend"> = {
    app: string(raw.app, "observation app"),
    title: string(raw.title, "observation title"),
    controls: array(raw.controls, "observation controls", controlShape),
    text: string(raw.text, "observation text"),
  };
  const url = optional(raw.url, "observation url", string);
  const window = optional(raw.window, "observation window", rectShape);
  if (url) seen.url = url;
  if (window) seen.window = window;
  if (optional(raw.truncated, "observation truncated", boolean)) seen.truncated = true;
  if (optional(raw.loading, "observation loading", boolean)) seen.loading = true;
  const popup = optional(raw.popup, "observation popup", string);
  if (popup) seen.popup = popup;
  return seen;
}

/** Every display's bounds (global, top-left-origin points). */
const DISPLAYS_SCRIPT = `${JXA_HELPERS}
function run() { return JSON.stringify(displays()); }`;

export function displaysShape(value: unknown): Rect[] {
  return array(value, "displays", rectShape);
}

/**
 * Text the keyboard types as is: printable ASCII on one line. Anything else (other scripts, emoji, line breaks,
 * where a typed Return would send a message) is pasted through a transient pasteboard instead.
 */
const KEYBOARD_TEXT = /^[\x20-\x7e]{1,400}$/;
/** Characters a keystroke script types at once: a stop takes effect between chunks. */
export const KEY_CHUNK = 50;
/** Time for a field (a web page's especially) to report what was typed before it is read back. */
const READBACK_MS = 200;

/** Splits text into chunks of at most `size` characters, never inside a surrogate pair. */
export function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1] ?? "")) end -= 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

const squash = (text: string) => text.replace(/\s+/g, "");

/**
 * Whether typed text is in the field now. A field that cannot be read back (null) is taken at its word; one that
 * reformats what was typed (spaces in a card number) still holds the same characters.
 */
export function landed(value: string | null, text: string): boolean {
  if (value === null) return true;
  return squash(value).includes(squash(text));
}

/** `automation`: whether macOS already lets Ada send Apple Events to an app, asked without a prompt. */
export type DesktopOptions = {
  sleep?: (ms: number) => Promise<void>;
  tmp?: () => string;
  automation?: AutomationCheck;
};

const SCREEN_RECORDING_OFF = "Screen Recording is off for Ada, so no screenshot was taken.";

/** The menu item each Command shortcut the act script presses stands for. */
const MENU_ITEMS: Record<string, string> = { A: "Select All", V: "Paste" };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const stopped = (signal: AbortSignal) =>
  new Error(typeof signal.reason === "string" && signal.reason ? signal.reason : "It was stopped.");

/** Reads the frontmost app's main window through accessibility and drives it with the real pointer and keyboard. */
export class DesktopBackend implements ScreenBackend {
  readonly kind = "desktop";
  private readonly runner: CommandRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tmp: () => string;
  private readonly automation: AutomationCheck | undefined;

  constructor(runner: CommandRunner = jxaRunner, options: DesktopOptions = {}) {
    this.runner = runner;
    this.sleep = options.sleep ?? pause;
    this.tmp =
      options.tmp ??
      (() => NodePath.join(NodeOS.tmpdir(), `ada-screen-${process.pid}-${Date.now()}.png`));
    this.automation = options.automation;
  }

  /** System Events key strokes only where macOS already said yes; never a question during a task. */
  private async systemEvents(): Promise<boolean> {
    return this.automation
      ? this.automation.allowed("com.apple.systemevents").catch(() => false)
      : false;
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    let output: string;
    try {
      output = await this.runner.run(
        ...jxa(
          OBSERVE_SCRIPT,
          options.app ? [options.app] : [],
          options.signal ? { signal: options.signal } : {},
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (UNREACHABLE.test(message))
        return this.observeScreenshot(macAccessError(message) ?? new Error(message));
      throw explain(message) ?? error;
    }
    return { backend: "desktop", ...observationShape(json(output.trim(), "observation")) };
  }

  /**
   * For an app that refuses accessibility: its front window's text, read on this Mac from a screenshot
   * (Vision), as spots to click. The screenshot is deleted at once. `refused` is thrown when nothing
   * could be read (no window). Without Screen Recording no screenshot is taken at all: on recent macOS a capture
   * without it can open the system's Screen Recording prompt in the middle of the task.
   */
  private async observeScreenshot(refused: Error): Promise<Observation> {
    const recording = await macAccess(this.runner).then(
      (access) => access.screenRecording,
      () => false,
    );
    if (!recording)
      throw new Error(
        `${refused.message} ${SCREEN_RECORDING_OFF} Reading its window from a screenshot needs it: allow Ada in System Settings › Privacy & Security › Screen Recording, then try again.`,
      );
    const front = frontWindowShape(
      json((await this.runner.run(...jxa(FRONT_WINDOW_SCRIPT))).trim(), "front window"),
    );
    if (!front.window) throw refused;
    const window = front.window;
    const file = this.tmp();
    let controls: ScreenControl[];
    try {
      await this.runner.run("screencapture", ["-x", "-o", `-l${window.id}`, file]);
      controls = visualControls(
        ocrShape(
          json((await this.runner.run(...jxa(OCR_SCRIPT, [file]))).trim() || "[]", "text lines"),
        ),
        window,
      );
    } catch {
      throw refused;
    } finally {
      await NodeFSP.rm(file, { force: true });
    }
    if (!controls.length) throw refused;
    return {
      backend: "desktop",
      app: front.app,
      title: window.title,
      controls,
      text: controls
        .map((control) => control.label)
        .join(" ")
        .slice(0, 1_500),
      visual: true,
      window: { x: window.x, y: window.y, w: window.w, h: window.h },
    };
  }

  /** Acts, and reports where a click, typing, or scroll left the pointer. */
  async act(action: ScreenAction, options: ActOptions = {}): Promise<ActResult> {
    const signal = options.signal;
    if (signal?.aborted) throw stopped(signal);
    if (action.kind === "type") return this.type(action.ref, action.text, options);
    const payload = { ...actionPayload(action), ...(options.allowPointer ? { allow: true } : {}) };
    return resultOf(await this.call(ACT_SCRIPT, [action.kind, JSON.stringify(payload)], signal));
  }

  /**
   * Typing in the background: set the field's value through accessibility (AXValue), which a native field and Chrome's
   * omnibox take without the keyboard, then read it back. A field that refuses it throws NeedsPointer; with the mouse
   * allowed, the field is clicked and the text typed (focus checked), or pasted when the keyboard cannot type it.
   */
  private async type(ref: string, text: string, options: ActOptions): Promise<ActResult> {
    const signal = options.signal;
    if (!options.allowPointer) {
      await this.call(ACT_SCRIPT, ["setvalue", JSON.stringify({ ref, text })], signal);
      await this.sleep(READBACK_MS);
      if (!landed(await this.readValue(ref, signal), text))
        throw new Error("The text did not land in the text box, so it stopped.");
      return { mode: "background", how: "value set through accessibility" };
    }
    const events = await this.systemEvents();
    const left = resultOf(
      await this.call(ACT_SCRIPT, ["focus", JSON.stringify({ ref, allow: true, events })], signal),
    );
    if (KEYBOARD_TEXT.test(text)) {
      for (const chunk of chunks(text, KEY_CHUNK)) {
        if (signal?.aborted) throw stopped(signal);
        await this.call(ACT_SCRIPT, ["keys", JSON.stringify({ text: chunk, events })], signal);
      }
    } else {
      await this.call(ACT_SCRIPT, ["paste", JSON.stringify({ ref, text, events })], signal);
    }
    await this.sleep(READBACK_MS);
    if (!landed(await this.readValue(ref, signal), text))
      throw new Error("The text did not land in the text box, so it stopped.");
    return {
      ...left,
      mode: "pointer",
      how: KEYBOARD_TEXT.test(text)
        ? "clicked into the field, typed keys"
        : "clicked into the field, pasted",
    };
  }

  private async readValue(ref: string, signal: AbortSignal | undefined): Promise<string | null> {
    const read = object(
      json(
        (await this.call(ACT_SCRIPT, ["value", JSON.stringify({ ref })], signal)).trim(),
        "typed value",
      ),
      "typed value",
    );
    return read.value === null || read.value === undefined
      ? null
      : string(read.value, "typed value");
  }

  /**
   * A window, or a region of the screen, as a PNG scaled so its longer edge is at most `maxEdge` pixels (a Retina
   * capture is twice the window's points). Without Screen Recording macOS returns the desktop instead (or opens its
   * prompt), so access is checked first, never asking. The file is deleted at once.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    const access = await macAccess(this.runner);
    if (!access.screenRecording)
      throw new Error(
        `${SCREEN_RECORDING_OFF} A screenshot needs it: allow Ada in System Settings › Privacy & Security › Screen Recording, then try again.`,
      );
    const front = frontWindowShape(
      json(
        (
          await this.call(FRONT_WINDOW_SCRIPT, options.app ? [options.app] : [], options.signal)
        ).trim(),
        "front window",
      ),
    );
    const window = front.window;
    if (!options.region && !window) throw new Error("The app in front has no open window.");
    const region = options.region ?? {
      x: window?.x ?? 0,
      y: window?.y ?? 0,
      w: window?.w ?? 0,
      h: window?.h ?? 0,
    };
    const file = this.tmp();
    try {
      const target = options.region
        ? `-R${region.x},${region.y},${region.w},${region.h}`
        : `-l${window?.id ?? 0}`;
      await this.runner.run(
        "screencapture",
        ["-x", "-o", "-t", "png", target, file],
        options.signal ? { signal: options.signal } : undefined,
      );
      let size = pixelSize(
        await this.runner.run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]),
      );
      const fit = fitScale(size.w, size.h, options.maxEdge ?? SCREENSHOT_MAX_EDGE);
      if (fit < 1) {
        await this.runner.run("sips", [
          "--resampleWidth",
          String(Math.max(1, Math.round(size.w * fit))),
          file,
        ]);
        size = pixelSize(
          await this.runner.run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]),
        );
      }
      return {
        png: new Uint8Array(await NodeFSP.readFile(file)),
        width: size.w,
        height: size.h,
        region,
        scale: region.w > 0 ? size.w / region.w : 1,
        app: front.app,
        title: window?.title ?? "",
      };
    } finally {
      await NodeFSP.rm(file, { force: true });
    }
  }

  async pointer(): Promise<PointerReading> {
    const value = json((await this.call(POINTER_SCRIPT, [])).trim(), "pointer");
    const point = pointShape(value, "pointer");
    const since = (value as { since_click_s?: unknown }).since_click_s;
    return typeof since === "number" && Number.isFinite(since) && since >= 0
      ? { ...point, sinceClickS: since }
      : point;
  }

  async displays(): Promise<Rect[]> {
    return displaysShape(json((await this.call(DISPLAYS_SCRIPT, [])).trim(), "displays"));
  }

  private async call(script: string, argv: string[], signal?: AbortSignal): Promise<string> {
    try {
      return await this.runner.run(...jxa(script, argv, signal ? { signal } : {}));
    } catch (error) {
      if (signal?.aborted) throw stopped(signal);
      throw explain(error instanceof Error ? error.message : String(error)) ?? error;
    }
  }
}

/** `sips -g pixelWidth -g pixelHeight` output → the image's size. */
export function pixelSize(output: string): { w: number; h: number } {
  const w = Number(/pixelWidth:\s*(\d+)/.exec(output)?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(output)?.[1]);
  if (!(w > 0) || !(h > 0)) throw new Error("The screenshot could not be read.");
  return { w, h };
}

/** An act script's result: its mode ("background" or "pointer"), where it acted (`at`) and where it left the real pointer. */
function resultOf(output: string): ActResult {
  const text = output.trim();
  if (!text.startsWith("{")) return { mode: "background" };
  let value: { mode?: unknown; at?: unknown; pointer?: unknown; how?: unknown };
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    return { mode: "background" };
  }
  const mode: ActResult["mode"] = value.mode === "pointer" ? "pointer" : "background";
  const point = (v: unknown) => (v && typeof v === "object" ? pointShape(v) : undefined);
  const result: ActResult = { mode };
  const at = point(value.at);
  const pointer = point(value.pointer);
  if (at) result.at = at;
  if (pointer) result.pointer = pointer;
  if (typeof value.how === "string" && value.how) result.how = value.how;
  return result;
}

/** Every script this backend runs, by name: the tests parse each one, as osascript would. */
export const SCRIPTS = {
  observe: OBSERVE_SCRIPT,
  act: ACT_SCRIPT,
  frontWindow: FRONT_WINDOW_SCRIPT,
  ocr: OCR_SCRIPT,
  access: ACCESS_SCRIPT,
  pointer: POINTER_SCRIPT,
  displays: DISPLAYS_SCRIPT,
};

/** A script failure in words a person can act on, or null to pass it through. */
function explain(message: string): Error | null {
  if (message.includes("ADA_GONE")) return new Error("That control is gone; look again.");
  const named = message.match(/ADA_NO_APP_NAMED:([^:]*):/);
  if (named) return new Error(`No app named “${named[1] ?? ""}” is running on the Mac.`);
  if (message.includes("ADA_NO_APP")) return new Error("No app is in front on the Mac.");
  if (message.includes("ADA_NO_WINDOW")) return new Error("The app in front has no open window.");
  if (message.includes("ADA_OFFSCREEN"))
    return new Error("That control is off screen; scroll it into view first.");
  const needs = message.match(/ADA_NEEDS_POINTER:([^:]*):/);
  if (needs) return new NeedsPointer((needs[1] ?? "").trim() || "it has no accessible action");
  if (message.includes("ADA_NOT_FOCUSED"))
    return new Error("The text box did not take the typing focus, so nothing was typed.");
  if (message.includes("ADA_NEWLINE"))
    return new Error("Line breaks are never typed as keys (a Return could send a message).");
  const menu = message.match(/ADA_NO_MENU_COMMAND:([A-Z]):/);
  if (menu) {
    const item = MENU_ITEMS[menu[1] ?? ""] ?? `⌘${menu[1] ?? ""}`;
    return new Error(
      `The app in front has no ${item} menu item (⌘${menu[1]}), so that was not done. Ada only uses an app's own menu for it: pressing the shortcut through System Events would make macOS ask for permission in the middle of the task.`,
    );
  }
  return macAccessError(message);
}
