// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/dock.ts), modified for Ada.
// LocalRouter ported it from Sidebud (github.com/jayleaton/sidebud @70da540); both notices ship in LICENSE.localrouter.
import { array, string } from "./validate.ts";
import { JXA_HELPERS, jxa, jxaRunner, macAccessError } from "./desktop.ts";
import type { CommandRunner } from "./macControls.ts";

/**
 * The apps in the Dock: the user's own reference for which apps they work in, so the screen
 * controller resolves "in Chrome", "in T3" against these rather than every background process. An
 * app is brought forward the way a person would: the real pointer clicks its Dock icon.
 */
const DOCK_ITEMS = `${JXA_HELPERS}
function items() {
  trusted();
  var dock = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.dock');
  if (!dock.count) return [];
  var app = $.AXUIElementCreateApplication(dock.objectAtIndex(0).processIdentifier), out = [];
  children(app).forEach(function (list) {
    children(list).forEach(function (item) {
      if (plain(item, 'AXSubrole') !== 'AXApplicationDockItem') return;
      var title = plain(item, 'AXTitle');
      if (title) out.push({ title: title, item: item });
    });
  });
  return out;
}
`;

const LIST_SCRIPT = `${DOCK_ITEMS}
function run() { return JSON.stringify(items().map(function (entry) { return entry.title; })); }
`;

const CLICK_SCRIPT = `${DOCK_ITEMS}
function run(argv) {
  var wanted = argv[0].toLowerCase(), dryrun = argv[1] === 'dryrun';
  var found = items().filter(function (entry) { return entry.title.toLowerCase() === wanted; })[0];
  if (!found) return 'missing';
  var point = center(found.item);
  if (!point) return 'missing';
  clickAt(point, dryrun);
  return 'clicked';
}
`;

export class DockApps {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner = jxaRunner) {
    this.runner = runner;
  }

  /** App names in the Dock, left to right (or top to bottom). */
  async list(): Promise<string[]> {
    try {
      return array(JSON.parse(await this.runner.run(...jxa(LIST_SCRIPT))), "Dock apps", string);
    } catch (error) {
      throw macAccessError(error instanceof Error ? error.message : String(error)) ?? error;
    }
  }

  /** Clicks the app's Dock icon with the cursor; an app not in the Dock is opened by name instead. */
  async activate(name: string, dryrun = false): Promise<"clicked" | "opened"> {
    let result: string;
    try {
      result = (
        await this.runner.run(...jxa(CLICK_SCRIPT, [name, dryrun ? "dryrun" : "act"]))
      ).trim();
    } catch (error) {
      throw macAccessError(error instanceof Error ? error.message : String(error)) ?? error;
    }
    if (result === "clicked") return "clicked";
    if (!dryrun) await this.runner.run("open", ["-a", name]);
    return "opened";
  }
}

/** Every script this backend runs, by name: the tests parse each one, as osascript would. */
export const SCRIPTS = { list: LIST_SCRIPT, click: CLICK_SCRIPT };
