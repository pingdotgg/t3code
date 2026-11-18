// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/backends.test.ts), modified for Ada.
// LocalRouter ported it from Sidebud (github.com/jayleaton/sidebud @70da540); both notices ship in LICENSE.localrouter.
import { describe, expect, it } from "vite-plus/test";
import { ChromeTabs, chooseInstance, SCRIPTS as CHROME_SCRIPTS } from "./chromeTabs.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  chunks,
  DesktopBackend,
  jxa,
  jxaRunner,
  jxaSource,
  landed,
  macAccess,
  SCRIPTS,
} from "./desktop.ts";
import { DockApps, SCRIPTS as DOCK_SCRIPTS } from "./dock.ts";
import { type CommandRunner, SCRIPTS as MAC_CONTROL_SCRIPTS } from "./macControls.ts";
import type { BrowserTab } from "./types.ts";

/** `args` is the process's own argv, which a listing shows; `argv` is what the script's `run(argv)` receives. */
type Call = { file: string; script: string; args: string[]; argv: string[] };

/** Every JXA script the helper runs: the desktop, Chrome's tabs, the Dock and the fixed controls. */
const JXA_SCRIPTS = {
  desktop: SCRIPTS,
  chromeTabs: CHROME_SCRIPTS,
  dock: DOCK_SCRIPTS,
  macControls: MAC_CONTROL_SCRIPTS,
};

// oxlint-disable-next-line t3code/no-global-process-runtime -- The helper is plain Node outside any Effect runtime.
const isMac = process.platform === "darwin";

/** Fake runner: `respond` returns stdout (or an Error to throw) for each call; every call is recorded. */
function fakeRunner(respond: (call: Call) => string | Error) {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    async run(file, args, options) {
      const call = {
        file,
        script: args[args.indexOf("-e") + 1] ?? "",
        args,
        argv: options?.input === undefined ? [] : (JSON.parse(options.input) as string[]),
      };
      calls.push(call);
      const result = respond(call);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { runner, calls };
}

const TAB: BrowserTab = {
  window: 0,
  index: 2,
  title: '-e Inbox (3) "quoted"',
  url: "https://mail.example.com/",
  active: false,
};

/**
 * The owner's Mac on 2026-09-26: a headless Chrome that Playwright launched (background-only, its
 * scripting answers with one tab) next to the owner's Chrome, whose window is in front.
 */
const HEADLESS = { pid: 22752, regular: false, frontmost: false, frontWindow: null };
const ON_SCREEN = { pid: 502, regular: true, frontmost: true, frontWindow: 0 };
const isInstances = (call: Call) => call.script.includes("runningApplicationsWithBundleIdentifier");

/** Chrome processes as `instances`, then `respond` for every other script. */
function chromeRunner(
  respond: (call: Call) => string | Error,
  instances: object[] = [HEADLESS, ON_SCREEN],
) {
  return fakeRunner((call) => (isInstances(call) ? JSON.stringify(instances) : respond(call)));
}

describe("ChromeTabs", () => {
  it('reads and clicks tabs in the Chrome process that owns the window on screen, not whichever one the name "Google Chrome" reaches', async () => {
    const tabs = [
      {
        window: 0,
        index: 14,
        title: "blink-182 - YouTube",
        url: "https://www.youtube.com/watch?v=1",
        active: false,
      },
    ];
    const { runner, calls } = chromeRunner(() => JSON.stringify(tabs));
    const chrome = new ChromeTabs(runner);
    expect(await chrome.list()).toEqual(tabs);
    await chrome.activate(tabs[0]!);
    const scripts = calls.filter((call) => !isInstances(call));
    expect(scripts.map((call) => call.argv[0])).toEqual(["502", "502"]);
    // Nothing is addressed to Chrome by name, which is what reached the headless process.
    for (const call of scripts) expect(call.script).not.toContain("Application('Google Chrome')");
  });

  it("picks the frontmost process, else the one with the frontmost window, and never a background-only one", () => {
    expect(chooseInstance([HEADLESS, ON_SCREEN])?.pid).toBe(502);
    const second = { pid: 900, regular: true, frontmost: false, frontWindow: 3 };
    const behind = { pid: 901, regular: true, frontmost: false, frontWindow: 7 };
    expect(chooseInstance([behind, second, HEADLESS])?.pid).toBe(900);
    expect(chooseInstance([{ ...behind, frontWindow: null }, HEADLESS])?.pid).toBe(901);
    expect(chooseInstance([HEADLESS])).toBeNull();
  });

  it("returns no tabs when no Chrome window can be on screen, without asking any process", async () => {
    const { runner, calls } = chromeRunner(() => new Error("should not be asked"), [HEADLESS]);
    expect(await new ChromeTabs(runner).list()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('passes the tab as argv after "--" and never splices its title into the script', async () => {
    const { runner, calls } = chromeRunner(() => '{"x":10,"y":20}');
    await new ChromeTabs(runner).activate(TAB);
    expect(calls[1]?.argv).toEqual(["502", TAB.title, "2", "click"]);
    for (const call of calls) expect(call.args.join("\n")).not.toContain(TAB.title);
    expect(calls[1]?.script).not.toContain("Inbox");
  });

  it("explains a tab that is not in the tab strip, and missing Accessibility access for the app running the helper", async () => {
    const missing = chromeRunner(
      () => new Error("execution error: Error: Error: ADA_NO_TAB (-2700)"),
    );
    await expect(new ChromeTabs(missing.runner).activate(TAB)).rejects.toThrow(
      "Could not find that tab in Chrome's tab strip.",
    );
    const denied = chromeRunner(
      () => new Error("execution error: Error: Error: ADA_NO_ACCESSIBILITY:Terminal: (-2700)"),
    );
    await expect(new ChromeTabs(denied.runner).activate(TAB)).rejects.toThrow(
      "Allow Terminal in System Settings › Privacy & Security › Accessibility",
    );
    const launchAgent = chromeRunner(
      () => new Error("execution error: Error: Error: ADA_NO_ACCESSIBILITY:: (-2700)"),
    );
    await expect(new ChromeTabs(launchAgent.runner).activate(TAB)).rejects.toThrow(
      "Allow the node binary that runs Ada",
    );
  });

  it("says Chrome itself is refusing, rather than blaming the tab or a permission", async () => {
    const { runner } = chromeRunner(
      () => new Error("execution error: Error: Error: ADA_UNREACHABLE:Google Chrome: (-2700)"),
    );
    const error = await new ChromeTabs(runner).list().then(
      () => new Error("listed"),
      (caught: Error) => caught,
    );
    expect(error.message).toMatch(
      /^Google Chrome is refusing to show its window to other apps.*Quitting and reopening Google Chrome fixes this/,
    );
    expect(error.message).not.toContain("Privacy & Security");
  });

  it("switches with Chrome’s tab search, typing the name only as argv, and reports the title now in front", async () => {
    const found = chromeRunner(() =>
      JSON.stringify({ before: "Sidebud · Computer", after: "blink-182 - YouTube", opened: true }),
    );
    expect(await new ChromeTabs(found.runner).search("YouTube")).toBe("blink-182 - YouTube");
    expect(found.calls[1]?.argv).toEqual(["502", "YouTube", "events"]);
    expect(found.calls[1]?.script).not.toContain("YouTube");
    const nothing = chromeRunner(() =>
      JSON.stringify({ before: "Sidebud · Computer", after: "Sidebud · Computer", opened: true }),
    );
    expect(await new ChromeTabs(nothing.runner).search("YouTube")).toBeNull();
    const closed = chromeRunner(() => JSON.stringify({ before: "x", after: "x", opened: false }));
    await expect(new ChromeTabs(closed.runner).search("YouTube")).rejects.toThrow(
      "Chrome's tab search did not open.",
    );
  });
});

describe("ChromeTabs with macOS’s Automation check", () => {
  const no = { allowed: async () => false };

  it("without macOS’s OK sends Chrome no Apple Event: the tab strip is read through accessibility", async () => {
    const tabs = [{ window: 0, index: 0, title: "Inbox", url: "", active: true }];
    const { runner, calls } = chromeRunner(() => JSON.stringify(tabs));
    const asked: string[] = [];
    expect(
      await new ChromeTabs(runner, {
        automation: { allowed: async (id) => (asked.push(id), false) },
      }).list(),
    ).toEqual(tabs);
    expect(asked).toEqual(["com.google.Chrome"]);
    expect(calls[1]?.argv).toEqual(["502", "ax"]);
    const yes = chromeRunner(() => "[]");
    await new ChromeTabs(yes.runner, { automation: { allowed: async () => true } }).list();
    expect(yes.calls[1]?.argv).toEqual(["502", "events"]);
  });

  it("tab search without the OK for System Events never presses its shortcut through it, and says why when the menu is out of reach", async () => {
    const found = chromeRunner(() =>
      JSON.stringify({ before: "a", after: "blink-182 - YouTube", opened: true, matched: true }),
    );
    expect(await new ChromeTabs(found.runner, { automation: no }).search("YouTube")).toBe(
      "blink-182 - YouTube",
    );
    expect(found.calls[1]?.argv).toEqual(["502", "YouTube", "none"]);
    // The name, Return and Escape go to Chrome's process as key events; System Events only on the "events" branch.
    expect(found.calls[1]?.script).toContain("typeText(pid, name, false)");
    expect(found.calls[1]?.script).toContain(
      "if (!events) return false;\n  Application('System Events')",
    );
    const blocked = chromeRunner(() =>
      JSON.stringify({ before: "a", after: "a", opened: false, blocked: true }),
    );
    await expect(
      new ChromeTabs(blocked.runner, { automation: no }).search("YouTube"),
    ).rejects.toThrow(
      /needs macOS's OK for Ada to control System Events, which Ada never asks for during a task/,
    );
  });
});

describe("DesktopBackend", () => {
  const observation = {
    app: "Mail",
    title: "Inbox",
    text: "Inbox 3 unread",
    controls: [
      { ref: "0.1", role: "button", label: "Compose" },
      { ref: "0.2.4", role: "textbox", label: "Search", value: "", focused: true },
      { ref: "0.3.0", role: "row", label: "Weekly report" },
    ],
  };

  it("parses an observation of the frontmost window", async () => {
    const { runner, calls } = fakeRunner(() => JSON.stringify(observation));
    expect(await new DesktopBackend(runner).observe()).toEqual({
      backend: "desktop",
      ...observation,
    });
    expect(calls[0]?.argv).toEqual([]);
    await new DesktopBackend(runner).observe({ app: "Calculator" });
    expect(calls[1]?.argv).toEqual(["Calculator"]);
  });

  it("scales a Retina window capture to the longest edge asked for, and says how image pixels map to points", async () => {
    let resized = false;
    const { runner, calls } = fakeRunner((call) => {
      if (call.script.includes("CGPreflightScreenCaptureAccess"))
        return '{"accessibility":true,"screenRecording":true,"host":""}';
      if (call.script.includes("CGWindowListCopyWindowInfo"))
        return JSON.stringify({
          app: "Safari",
          window: { id: 7, x: 100, y: 50, w: 1440, h: 900, title: "Docs" },
        });
      if (call.file === "sips" && call.args.includes("--resampleWidth")) {
        resized = true;
        return "";
      }
      if (call.file === "sips")
        return resized
          ? "pixelWidth: 1568\n  pixelHeight: 980\n"
          : "pixelWidth: 2880\n  pixelHeight: 1800\n";
      return "";
    });
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ada-shot-"));
    const file = NodePath.join(dir, "shot.png");
    NodeFS.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const shot = await new DesktopBackend(runner, { tmp: () => file }).screenshot({
      maxEdge: 1568,
    });
    expect(shot).toMatchObject({
      width: 1568,
      height: 980,
      region: { x: 100, y: 50, w: 1440, h: 900 },
      app: "Safari",
      title: "Docs",
    });
    expect(shot.scale).toBeCloseTo(1568 / 1440);
    expect(Array.from(shot.png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(calls.find((call) => call.args.includes("--resampleWidth"))?.args).toEqual([
      "--resampleWidth",
      "1568",
      file,
    ]);
    expect(NodeFS.existsSync(file)).toBe(false);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an observation with a role outside the closed set", async () => {
    const { runner } = fakeRunner(() =>
      JSON.stringify({
        ...observation,
        controls: [{ ref: "0.1", role: "slider", label: "Volume" }],
      }),
    );
    await expect(new DesktopBackend(runner).observe()).rejects.toThrow(/role should be one of/);
  });

  it("sends refs, text and key codes only as argv, acting in the background", async () => {
    const { runner, calls } = fakeRunner((call) =>
      call.argv[0] === "value"
        ? JSON.stringify({ value: "'); Application('Finder').delete(); ('" })
        : JSON.stringify({ mode: "background" }),
    );
    const desktop = new DesktopBackend(runner, { sleep: async () => {} });
    const text = "'); Application('Finder').delete(); ('";
    await desktop.act({ kind: "type", ref: "0.2.4", text });
    await desktop.act({ kind: "click", ref: "0.1" });
    await desktop.act({ kind: "press", key: "enter" });
    await desktop.act({ kind: "scroll", direction: "bottom" });
    await desktop.act({ kind: "scroll", direction: "down", ref: "0.3" });
    await desktop.act({ kind: "press", key: "space" });
    await desktop.act({ kind: "press", key: "up" });
    await desktop.act({ kind: "press", key: "cmd+l" });
    expect(calls.map((call) => call.argv)).toEqual([
      ["setvalue", JSON.stringify({ ref: "0.2.4", text })],
      ["value", JSON.stringify({ ref: "0.2.4" })],
      ["click", JSON.stringify({ ref: "0.1" })],
      ["press", JSON.stringify({ code: 36 })],
      ["scroll", JSON.stringify({ direction: "bottom" })],
      ["scroll", JSON.stringify({ direction: "down", ref: "0.3" })],
      ["press", JSON.stringify({ code: 49 })],
      ["press", JSON.stringify({ code: 126 })],
      ["press", JSON.stringify({ code: 37, command: "L" })],
    ]);
    // The value and text travel as argv on stdin, never spliced into the script source.
    expect(calls[0]?.script).not.toContain("Finder");
    // Nor in osascript's own argv, which any process listing shows.
    for (const call of calls) expect(call.args.join("\n")).not.toContain("Finder");
  });

  it("types in the background by setting the field value, and types with keys only when the pointer is allowed", async () => {
    const typed: string[] = [];
    const { runner, calls } = fakeRunner((call) => {
      const payload = JSON.parse(call.argv[1] ?? "{}") as { text?: string };
      if (call.argv[0] === "keys" || call.argv[0] === "paste" || call.argv[0] === "setvalue")
        typed.push(payload.text ?? "");
      return call.argv[0] === "value"
        ? JSON.stringify({ value: typed.join("") })
        : JSON.stringify({ mode: "pointer", pointer: { x: 10, y: 20 }, at: { x: 10, y: 20 } });
    });
    const desktop = new DesktopBackend(runner, { sleep: async () => {} });
    const long = "a".repeat(120);
    // Background (default): one AXValue set, then a read-back. No pointer, no keyboard.
    expect(await desktop.act({ kind: "type", ref: "0.1", text: long })).toEqual({
      mode: "background",
      how: "value set through accessibility",
    });
    expect(calls.map((call) => call.argv[0])).toEqual(["setvalue", "value"]);
    // With the person's leave, the field is clicked and the text typed in chunks a stop can come between.
    typed.length = 0;
    calls.length = 0;
    expect(
      await desktop.act({ kind: "type", ref: "0.1", text: long }, { allowPointer: true }),
    ).toMatchObject({ mode: "pointer", pointer: { x: 10, y: 20 } });
    expect(
      calls
        .filter((call) => call.argv[0] === "keys")
        .map((call) => (JSON.parse(call.argv[1] ?? "{}") as { text: string }).text.length),
    ).toEqual([50, 50, 20]);
    // Line breaks, other scripts and emoji go through the pasteboard, whole.
    for (const text of ["line one\nline two", "Grüße, 你好 👋"]) {
      typed.length = 0;
      calls.length = 0;
      await desktop.act({ kind: "type", ref: "0.1", text }, { allowPointer: true });
      expect(calls.map((call) => call.argv[0])).toEqual(["focus", "paste", "value"]);
    }
    const stop = new AbortController();
    stop.abort("You stopped it on this computer.");
    await expect(
      desktop.act({ kind: "type", ref: "0.1", text: long }, { signal: stop.signal }),
    ).rejects.toThrow("You stopped it on this computer.");
  });

  it("presses a button through accessibility (background), and asks for the mouse when there is no accessible action", async () => {
    const press = fakeRunner(() => JSON.stringify({ mode: "background", at: { x: 40, y: 50 } }));
    expect(await new DesktopBackend(press.runner).act({ kind: "click", ref: "0.1" })).toEqual({
      mode: "background",
      at: { x: 40, y: 50 },
    });
    expect(press.calls[0]?.argv).toEqual(["click", JSON.stringify({ ref: "0.1" })]);
    // No accessible action and the pointer not allowed: NeedsPointer, so the controller asks the person for their mouse.
    const noAction = fakeRunner(
      () =>
        new Error(
          "execution error: ADA_NEEDS_POINTER:that control has no accessible action: (-2700)",
        ),
    );
    await expect(
      new DesktopBackend(noAction.runner).act({ kind: "click", ref: "0.1" }),
    ).rejects.toThrow(/needs your mouse for a moment/);
    // With the mouse allowed, it clicks for real and reports pointer mode.
    const allowed = fakeRunner(() =>
      JSON.stringify({ mode: "pointer", pointer: { x: 5, y: 6 }, at: { x: 5, y: 6 } }),
    );
    expect(
      await new DesktopBackend(allowed.runner).act(
        { kind: "click", ref: "0.1" },
        { allowPointer: true },
      ),
    ).toEqual({ mode: "pointer", pointer: { x: 5, y: 6 }, at: { x: 5, y: 6 } });
    expect(allowed.calls[0]?.argv).toEqual(["click", JSON.stringify({ ref: "0.1", allow: true })]);
    expect(SCRIPTS.act).toContain("AXUIElementPerformAction(el, $('AXPress'))");
  });

  it("the act script: a click on a field with no AXPress (Chrome’s omnibox) focuses it through AXFocused, never the pointer", () => {
    // The real act script, run with a stand-in AX bridge: the element's role, its actions and whether AXFocused is settable.
    type El = { role: string; actions?: string[]; focusSettable?: boolean; setRefused?: boolean };
    const act = (el: El, payload: Record<string, unknown> = { ref: "0.1" }) => {
      const log: string[] = [];
      const $ = Object.assign((s: string) => s, {
        AXUIElementCopyActionNames: (_e: El, ref: unknown[]) => (
          (ref[0] = {
            count: (el.actions ?? []).length,
            objectAtIndex: (i: number) => (el.actions ?? [])[i],
          }),
          0
        ),
        AXUIElementPerformAction: (_e: El, name: string) => (log.push(`perform ${name}`), 0),
        AXUIElementIsAttributeSettable: (_e: El, _name: string, ref: unknown[]) => (
          (ref[0] = el.focusSettable === true),
          0
        ),
        AXUIElementSetAttributeValue: (_e: El, name: string, value: unknown) => (
          log.push(`set ${name}=${String(value)}`),
          el.setRefused ? -25205 : 0
        ),
        NSNumber: { numberWithBool: (b: boolean) => b },
      });
      const ObjC = {
        import: () => undefined,
        unwrap: (x: unknown) => x,
        castRefToObject: (x: unknown) => x,
      };
      const stubs = `
function trusted() {}
function front() { return { win: {}, app: {} }; }
function resolve() { return __el; }
function center() { return [40, 50]; }
function plain(e, name) { return name === 'AXRole' ? e.role : undefined; }
function clickAt() { __log.push('pointer click'); }
return run;`;
      const run = new Function(
        "$",
        "ObjC",
        "Ref",
        "Application",
        "delay",
        "__el",
        "__log",
        `${SCRIPTS.act}\n${stubs}`,
      )(
        $,
        ObjC,
        () => [],
        () => ({}),
        () => undefined,
        el,
        log,
      ) as (argv: string[]) => string;
      try {
        return {
          out: JSON.parse(run(["click", JSON.stringify(payload)])) as Record<string, unknown>,
          log,
        };
      } catch (error) {
        return { error: (error as Error).message, log };
      }
    };
    // Chrome's omnibox: an AXTextField with no AXPress. Focused in the background.
    expect(act({ role: "AXTextField", actions: ["AXShowMenu"] })).toEqual({
      out: { mode: "background", at: { x: 40, y: 50 }, how: "focused through accessibility" },
      log: ["set AXFocused=true"],
    });
    // Any other control whose AXFocused is settable (a web group with a tabindex): the same.
    expect(act({ role: "AXGroup", focusSettable: true }).out).toMatchObject({
      mode: "background",
      how: "focused through accessibility",
    });
    // A button is pressed, not focused.
    expect(act({ role: "AXButton", actions: ["AXPress"] })).toEqual({
      out: { mode: "background", at: { x: 40, y: 50 } },
      log: ["perform AXPress"],
    });
    // Nothing to press and nothing to focus (or the app refused the focus): only then the mouse is asked for.
    expect(act({ role: "AXImage" }).error).toMatch(/ADA_NEEDS_POINTER/);
    expect(act({ role: "AXTextField", setRefused: true }).error).toMatch(/ADA_NEEDS_POINTER/);
    expect(act({ role: "AXImage" }, { ref: "0.1", allow: true })).toEqual({
      out: { mode: "pointer", pointer: { x: 40, y: 50 }, at: { x: 40, y: 50 } },
      log: ["pointer click"],
    });
    // With the mouse allowed, a field is still focused in the background: the pointer is the last resort.
    expect(act({ role: "AXTextField" }, { ref: "0.1", allow: true }).log).toEqual([
      "set AXFocused=true",
    ]);
  });

  it("the act script sends no Apple Event unless macOS already allows it: typed text is Unicode key events posted to the front app’s process", () => {
    // System Events appears only behind payload.events / events (allowed already, checked without asking).
    const unguarded = SCRIPTS.act
      .split("\n")
      .filter(
        (line) =>
          /\bApplication\(|\.keystroke\(|\.keyCode\(/.test(line) && !/\bevents\b/.test(line),
      );
    expect(unguarded).toEqual([]);
    const posted: Array<{ pid: number; down: boolean; text: string; flags: number }> = [];
    const opened: string[] = [];
    type Units = { units: string };
    const $ = Object.assign(
      (s = "") => ({
        length: s.length,
        getCharactersRange: (into: Units) => {
          into.units = s;
        },
      }),
      {
        NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 4242 } } },
        NSMutableData: { dataWithLength: () => ({ mutableBytes: { units: "" } }) },
        NSMakeRange: (at: number, length: number) => ({ at, length }),
        CGEventCreateKeyboardEvent: (_source: unknown, _code: number, down: boolean) => ({
          down,
          text: "",
          flags: -1,
        }),
        CGEventSetFlags: (event: { flags: number }, flags: number) => {
          event.flags = flags;
        },
        CGEventKeyboardSetUnicodeString: (event: { text: string }, count: number, units: Units) => {
          event.text = units.units.slice(0, count);
        },
        CGEventPostToPid: (pid: number, event: { down: boolean; text: string; flags: number }) =>
          posted.push({ pid, ...event }),
        kCGHIDEventTap: 0,
      },
    );
    const ObjC = {
      import: () => undefined,
      unwrap: (x: unknown) => x,
      castRefToObject: (x: unknown) => x,
    };
    const run = new Function(
      "$",
      "ObjC",
      "Ref",
      "Application",
      "delay",
      `${SCRIPTS.act}\nfunction trusted() {}\nreturn run;`,
    )(
      $,
      ObjC,
      () => [],
      (name: string) => (opened.push(name), { keystroke: () => undefined }),
      () => undefined,
    ) as (argv: string[]) => string;
    const text = `${"x".repeat(19)}👋 and more text`;
    expect(JSON.parse(run(["keys", JSON.stringify({ text })]))).toEqual({ mode: "pointer" });
    expect(opened).toEqual([]);
    // Down and up per chunk, to the front app's pid, no modifiers, at most 20 UTF-16 units, never half an emoji.
    expect(posted.every((event) => event.pid === 4242 && event.flags === 0)).toBe(true);
    expect(posted.map((event) => event.down)).toEqual([true, false, true, false]);
    expect(posted.filter((event) => event.down).map((event) => event.text)).toEqual([
      "x".repeat(19),
      "👋 and more text",
    ]);
    expect(
      posted
        .filter((event) => event.down)
        .map((event) => event.text)
        .join(""),
    ).toBe(text);
    // Where macOS already allows System Events (JJ's Mac), its keystroke is kept: the path that worked there.
    posted.length = 0;
    expect(JSON.parse(run(["keys", JSON.stringify({ text: "hi", events: true })]))).toEqual({
      mode: "pointer",
    });
    expect(opened).toEqual(["System Events"]);
    expect(posted).toEqual([]);
  });

  it("selects or pastes only through the app’s own menu: without the menu item it stops and says why, never a keystroke", async () => {
    const opened: string[] = [];
    const $ = Object.assign((s: string) => s, { NSNumber: { numberWithBool: (b: boolean) => b } });
    const ObjC = {
      import: () => undefined,
      unwrap: (x: unknown) => x,
      castRefToObject: (x: unknown) => x,
    };
    const stubs = `
function trusted() {}
function front() { return { win: {}, app: {} }; }
function resolve() { return {}; }
function center() { return [40, 50]; }
function clickAt() {}
function hasFocus() { return true; }
function attr() { return null; }
function plain(e, name) { return name === 'AXValue' ? 'old text' : undefined; }
return run;`;
    const run = new Function(
      "$",
      "ObjC",
      "Ref",
      "Application",
      "delay",
      `${SCRIPTS.act}\n${stubs}`,
    )(
      $,
      ObjC,
      () => [],
      (name: string) => opened.push(name),
      () => undefined,
    ) as (argv: string[]) => string;
    expect(() => run(["focus", JSON.stringify({ ref: "0.1", allow: true })])).toThrow(
      "ADA_NO_MENU_COMMAND:A:",
    );
    expect(opened).toEqual([]);
    const { runner } = fakeRunner(
      () => new Error("execution error: Error: ADA_NO_MENU_COMMAND:A: (-2700)"),
    );
    await expect(
      new DesktopBackend(runner).act(
        { kind: "type", ref: "0.1", text: "x" },
        { allowPointer: true },
      ),
    ).rejects.toThrow(
      /^The app in front has no Select All menu item \(⌘A\), so that was not done\..*System Events would make macOS ask/,
    );
  });

  it("fails a typing step whose text did not land, without repeating the text", async () => {
    const { runner } = fakeRunner((call) =>
      call.argv[0] === "value" ? '{"value":"something else"}' : "ok",
    );
    const error = await new DesktopBackend(runner, { sleep: async () => {} })
      .act({ kind: "type", ref: "0.1", text: "groceries" })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The text did not land in the text box, so it stopped.");
    expect(landed(null, "x")).toBe(true);
    expect(landed("4111 1111 1111 1111", "4111111111111111")).toBe(true);
    expect(landed("", "x")).toBe(false);
  });

  it("never splits a surrogate pair between chunks", () => {
    const text = `${"a".repeat(49)}👋b`;
    expect(chunks(text, 50)).toEqual(["a".repeat(49), "👋b"]);
    expect(chunks("", 50)).toEqual([]);
  });

  it("explains a text box that would not take the focus, and a control off every display", async () => {
    const focus = fakeRunner(() => new Error("execution error: Error: ADA_NOT_FOCUSED (-2700)"));
    await expect(
      new DesktopBackend(focus.runner).act({ kind: "type", ref: "0.1", text: "x" }),
    ).rejects.toThrow("The text box did not take the typing focus, so nothing was typed.");
    const off = fakeRunner(() => new Error("execution error: Error: ADA_OFFSCREEN (-2700)"));
    await expect(new DesktopBackend(off.runner).act({ kind: "click", ref: "0.1" })).rejects.toThrow(
      "That control is off screen; scroll it into view first.",
    );
  });

  it("selects a field’s text through the Edit menu by its character, never with key code 0 (⌘Q on AZERTY)", () => {
    expect(SCRIPTS.act).toContain("menuCommand(app, letter)");
    expect(SCRIPTS.act).not.toMatch(/keyCode\(0,/);
  });

  it("parses every script it runs as JavaScript, as osascript would", () => {
    for (const [group, scripts] of Object.entries(JXA_SCRIPTS)) {
      for (const [name, script] of Object.entries(scripts)) {
        expect(() => new Function(script), `${group} ${name}`).not.toThrow();
      }
    }
  });

  it("reads the displays, and the page a browser shows, the window and whether the walk was cut short", async () => {
    const displays = [
      { x: 0, y: 0, w: 1512, h: 982 },
      { x: -1920, y: -98, w: 1920, h: 1080 },
    ];
    expect(
      await new DesktopBackend(fakeRunner(() => JSON.stringify(displays)).runner).displays(),
    ).toEqual(displays);
    const seen = {
      ...observation,
      url: "https://mail.example.com/",
      window: { x: 0, y: 25, w: 1200, h: 800 },
      truncated: true,
    };
    expect(
      await new DesktopBackend(fakeRunner(() => JSON.stringify(seen)).runner).observe(),
    ).toEqual({ backend: "desktop", ...seen });
  });

  it("reports the mode and where it acted, for the audit", async () => {
    const bg = fakeRunner(() => JSON.stringify({ mode: "background", at: { x: 640, y: 212 } }));
    expect(await new DesktopBackend(bg.runner).act({ kind: "click", ref: "0.1" })).toEqual({
      mode: "background",
      at: { x: 640, y: 212 },
    });
    const pressOk = fakeRunner(() => JSON.stringify({ mode: "background" }));
    expect(await new DesktopBackend(pressOk.runner).act({ kind: "press", key: "enter" })).toEqual({
      mode: "background",
    });
  });

  it('reads screenshot spots ("v:x,y") with a real digit class in the JXA source', async () => {
    const { runner, calls } = fakeRunner(() => "ok");
    await new DesktopBackend(runner).act({ kind: "click", ref: "v:1850,72" });
    // A bare \d inside the TypeScript template literal would reach osascript as a plain "d".
    expect(calls[0]?.script).toContain("/^v:(-?[\\d.]+),(-?[\\d.]+)$/");
  });

  it("reads the pointer without moving it", async () => {
    const { runner, calls } = fakeRunner(() => '{"x":1.5,"y":2}\n');
    expect(await new DesktopBackend(runner).pointer()).toEqual({ x: 1.5, y: 2 });
    expect(calls[0]?.script).toContain("CGEventGetLocation");
  });

  it("says a control is gone when its ref no longer resolves", async () => {
    const { runner } = fakeRunner(
      () => new Error("execution error: Error: Error: ADA_GONE (-2700)"),
    );
    await expect(new DesktopBackend(runner).act({ kind: "click", ref: "9.9" })).rejects.toThrow(
      "That control is gone; look again.",
    );
  });

  it("maps accessibility and automation refusals to the setting to change", async () => {
    const accessibility = fakeRunner(
      () =>
        new Error("System Events got an error: osascript is not allowed assistive access. (-1719)"),
    );
    await expect(new DesktopBackend(accessibility.runner).observe()).rejects.toThrow(
      /Privacy & Security › Accessibility/,
    );
    const automation = fakeRunner(
      () => new Error("Not authorized to send Apple events to System Events. (-1743)"),
    );
    await expect(
      new DesktopBackend(automation.runner).act({ kind: "press", key: "tab" }),
    ).rejects.toThrow(/Privacy & Security › Automation/);
  });

  it("reads an app that refuses accessibility from a screenshot of its front window, as text spots to click", async () => {
    const window = { id: 86, x: 50, y: 30, w: 2000, h: 1400, title: "blink-182 - YouTube" };
    const { runner, calls } = fakeRunner((call) => {
      if (call.script.includes("CGPreflightScreenCaptureAccess"))
        return '{"accessibility":true,"screenRecording":true,"host":""}';
      if (call.file === "screencapture") return "";
      if (
        call.script.includes("ADA_UNREACHABLE") &&
        call.script.includes("AXMainWindow") &&
        !call.script.includes("CGWindowListCopyWindowInfo")
      )
        return new Error("execution error: Error: Error: ADA_UNREACHABLE:Google Chrome: (-2700)");
      if (call.script.includes("VNRecognizeTextRequest"))
        return JSON.stringify([
          { text: "Search", x: 0.25, y: 0.88, w: 0.1, h: 0.02 },
          { text: "•", x: 0.1, y: 0.5, w: 0.01, h: 0.01 },
          { text: "blink-182 - YouTube", x: 0.8, y: 0.97, w: 0.1, h: 0.02 },
        ]);
      return JSON.stringify({ app: "Google Chrome", window });
    });
    const screen = await new DesktopBackend(runner).observe();
    expect(screen).toMatchObject({
      backend: "desktop",
      app: "Google Chrome",
      title: "blink-182 - YouTube",
      visual: true,
      text: "blink-182 - YouTube Search",
    });
    // Spots are window-relative boxes turned into screen points (bottom-left origin to top-left).
    expect(screen.controls).toEqual([
      { ref: "v:1750,58", role: "text", label: "blink-182 - YouTube" },
      { ref: "v:650,184", role: "text", label: "Search" },
    ]);
    const capture = calls.find((call) => call.file === "screencapture");
    expect(capture).toBeDefined();
  });

  it("says why when an app refuses accessibility and its screenshot shows nothing", async () => {
    const { runner } = fakeRunner((call) => {
      if (call.script.includes("CGPreflightScreenCaptureAccess"))
        return '{"accessibility":true,"screenRecording":true,"host":""}';
      if (call.file === "screencapture") return "";
      if (call.script.includes("VNRecognizeTextRequest")) return "[]";
      if (
        call.script.includes("AXMainWindow") &&
        !call.script.includes("CGWindowListCopyWindowInfo")
      )
        return new Error("ADA_UNREACHABLE:Google Chrome:");
      return JSON.stringify({
        app: "Google Chrome",
        window: { id: 1, x: 0, y: 0, w: 10, h: 10, title: "" },
      });
    });
    await expect(new DesktopBackend(runner).observe()).rejects.toThrow(
      /^Google Chrome is refusing to show its window/,
    );
  });

  it("never runs screencapture without Screen Recording (it could open the system prompt mid-task), and says so", async () => {
    const { runner, calls } = fakeRunner((call) => {
      if (call.script.includes("CGPreflightScreenCaptureAccess"))
        return '{"accessibility":true,"screenRecording":false,"host":""}';
      if (
        call.script.includes("AXMainWindow") &&
        !call.script.includes("CGWindowListCopyWindowInfo")
      )
        return new Error("ADA_UNREACHABLE:Google Chrome:");
      return JSON.stringify({
        app: "Google Chrome",
        window: { id: 1, x: 0, y: 0, w: 900, h: 700, title: "" },
      });
    });
    await expect(new DesktopBackend(runner).observe()).rejects.toThrow(
      /^Google Chrome is refusing to show its window.*Screen Recording is off for Ada, so no screenshot was taken/,
    );
    await expect(new DesktopBackend(runner).screenshot()).rejects.toThrow(
      /^Screen Recording is off for Ada/,
    );
    expect(calls.some((call) => call.file === "screencapture")).toBe(false);
  });

  it("passes other failures through unchanged", async () => {
    const { runner } = fakeRunner(
      () => new Error("The Mac (osascript) took too long to answer (timed out)"),
    );
    await expect(new DesktopBackend(runner).observe()).rejects.toThrow("took too long to answer");
  });
});

describe("macAccess", () => {
  it("reports Accessibility, Screen Recording, and the app macOS attributes the helper to", async () => {
    const { runner } = fakeRunner(
      () => '{"accessibility":true,"screenRecording":false,"host":""}\n',
    );
    expect(await macAccess(runner)).toEqual({
      accessibility: true,
      screenRecording: false,
      host: "",
    });
  });
});

describe("DockApps", () => {
  it("lists the Dock's apps, clicks an app's icon to bring it forward, and opens one that is not in the Dock", async () => {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const replies = ['["Finder","Google Chrome","T3 Agents"]', "clicked", "missing", ""];
    const dock = new DockApps({
      run: async (file, args, options) => {
        calls.push({
          file,
          args,
          ...(options?.input === undefined ? {} : { input: options.input }),
        });
        return replies.shift() ?? "";
      },
    });
    expect(await dock.list()).toEqual(["Finder", "Google Chrome", "T3 Agents"]);
    expect(await dock.activate("Google Chrome")).toBe("clicked");
    // The app name reaches the script on stdin, never inside its source or osascript's argv.
    expect(JSON.parse(calls[1]!.input ?? "[]")).toEqual(["Google Chrome", "act"]);
    expect(calls[1]!.args.join("\n")).not.toContain("Google Chrome");
    expect(await dock.activate("Zed")).toBe("opened");
    expect(calls.at(-1)).toEqual({ file: "open", args: ["-a", "Zed"] });
    // No Apple Event: the Dock is read through accessibility and clicked with CGEvent, `open -a` is LaunchServices.
    for (const call of calls)
      expect(call.args.join(" ")).not.toMatch(/System Events|\bApplication\(|tell application/);
  });
});

describe("ChromeTabs.groups", () => {
  it("reads named tab groups from the tab strip's order", async () => {
    const tabs = new ChromeTabs(
      chromeRunner(() =>
        JSON.stringify([
          { name: "Work", tabs: ["Sidebud · Computer", "Internal testing | Sidebud"] },
        ]),
      ).runner,
    );
    expect(await tabs.groups()).toEqual([
      { name: "Work", tabs: ["Sidebud · Computer", "Internal testing | Sidebud"] },
    ]);
  });
});

/** On a Mac (the macOS CI runner): every script compiles as osascript compiles it, and the reads that need no permission run. */
describe.runIf(isMac)("on macOS", () => {
  it("compiles every script with osacompile", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ada-jxa-"));
    try {
      for (const [group, scripts] of Object.entries(JXA_SCRIPTS)) {
        for (const [name, script] of Object.entries(scripts)) {
          const file = NodePath.join(dir, `${group}-${name}.js`);
          // As osascript runs it: wrapped to read its argv from stdin.
          NodeFS.writeFileSync(file, jxaSource(script));
          await expect(
            jxaRunner.run("osacompile", [
              "-l",
              "JavaScript",
              "-o",
              NodePath.join(dir, `${group}-${name}.scpt`),
              file,
            ]),
            `${group} ${name}`,
          ).resolves.toBeDefined();
        }
      }
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands a script its argv on stdin", async () => {
    const text = 'on my way -- 10\' late, "ok"';
    const echoed = await jxaRunner.run(
      ...jxa("function run(argv) { return argv.join('|'); }", [text, "x"]),
    );
    expect(echoed.trim()).toBe(`${text}|x`);
  });

  it("reads the displays, the pointer and the grants for real", async () => {
    const desktop = new DesktopBackend();
    const displays = await desktop.displays();
    expect(displays.length).toBeGreaterThan(0);
    expect(displays[0]).toMatchObject({ x: 0, y: 0 });
    const pointer = await desktop.pointer();
    expect(Number.isFinite(pointer.x) && Number.isFinite(pointer.y)).toBe(true);
    const access = await macAccess();
    expect(typeof access.accessibility).toBe("boolean");
  });
});
