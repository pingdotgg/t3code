/**
 * Runs every scene in `deck.ts` for real, in order, against one project
 * folder (`work/shorty`), and writes what the video needs to `out/capture/`:
 *
 *   out/capture/<scene>/scene.json      beats (see shared/types.ts)
 *   out/capture/<scene>/terminal.mp4    the terminal, rendered by tcut
 *   out/capture/<scene>/browser-<n>.png real page captures
 *
 * The project starts empty and each scene brings it to the matching
 * `chapters/<chapter>` folder: files typed on screen are written as they
 * are typed, the rest are synced silently. The terminal is one tmux
 * session for the whole talk: `alchemy dev` runs in the top pane from
 * chapter 1 on, commands and tests run in the bottom pane.
 *
 *   pnpm capture                 # all scenes, then tear everything down
 *   pnpm capture --keep          # leave dev/live deployments up
 *   pnpm capture --only 03-tests # re-capture one scene (needs the previous ones' project state)
 *
 * Needs Bun >= 1.4.1 (tcut); the package script runs it with `bunx bun@1.4.2`.
 * Deploys use the `ALCHEMY_PROFILE` profile (default `testing`).
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildTimeline, defineVideo, type TerminalSession } from "tcut";
import { deck } from "../deck.ts";
import {
  BROWSER_VIEWPORT,
  TERMINAL,
  VIDEO,
  type Beat,
  type Desk,
  type Graph,
  type SceneCapture,
} from "../shared/types.ts";
import { readGraph } from "./graph.ts";
import type { Pane, SceneContext, SceneDefinition, Term } from "./scene.ts";

const { values: args } = parseArgs({
  options: {
    keep: { type: "boolean", default: false },
    only: { type: "string" },
  },
});

const root = path.resolve(import.meta.dir, "..");
const project = "shorty";
const dir = path.join(root, "work", project);
const chaptersDir = path.join(root, "chapters");
const captureRoot = path.join(root, "out", "capture");
const bin = path.join(root, "node_modules", ".bin");
const profile = process.env.ALCHEMY_PROFILE ?? "testing";
const tmuxConf = path.join(root, "capture", "tmux.conf");
const zdot = path.join(root, "work", ".zdot");
const SOCKET = "shorty-demo";
const SESSION = "shorty";
/** Terminal tabs are tmux windows, drawn by tmux's own status line so tab and content always agree. */
const TABS: Pane[] = ["deploy", "test", "dev"];
const PANES: Record<Pane, string> = {
  deploy: `${SESSION}:0`,
  test: `${SESSION}:1`,
  dev: `${SESSION}:2`,
};
/** The tab on screen; persists across scenes like the real terminal would. */
let currentTab: Pane = "deploy";

/** Beat markers written into the tcut recording around terminal beats. */
const BEAT = "prezzy-beat:";
/** Markers recording which terminal tab is on screen. */
const TAB = "prezzy-tab:";

/** Never copied into the project or shown in the explorer. */
const IGNORED = new Set(["node_modules", ".alchemy", "dist", ".DS_Store", "tsconfig.tsbuildinfo"]);

const listFiles = async (base: string, rel = ""): Promise<string[]> => {
  const entries = await readdir(path.join(base, rel), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(base, child)));
    else files.push(child);
  }
  return files.sort();
};

const readText = (file: string) => readFile(file, "utf8").catch(() => "");
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const sh = async (cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}) => {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd ?? dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [
    await new Response(proc.stdout).text(),
    await new Response(proc.stderr).text(),
  ];
  const code = await proc.exited;
  if (code !== 0 && !opts.quiet)
    throw new Error(`${cmd.join(" ")} failed (${code}): ${err || out}`);
  return out;
};
const tmux = (...rest: string[]) => sh(["tmux", "-L", SOCKET, ...rest], { quiet: true });

const paneText = async (pane: Pane) =>
  tmux("capture-pane", "-p", "-J", "-S", "-", "-t", PANES[pane]);

const waitFor = async (pane: Pane, pattern: RegExp, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await paneText(pane);
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${pattern} in the ${pane} pane:\n${text.slice(-3000)}`,
      );
    }
    await Bun.sleep(300);
  }
};

/** A fresh tmux session with a clean zsh in each pane, sized for the terminal clip. */
const startTmux = async (cols: number, rows: number) => {
  await mkdir(zdot, { recursive: true });
  await writeFile(
    path.join(zdot, ".zshrc"),
    [
      `PROMPT='%F{green}~/${project}%f %F{8}❯%f '`,
      "PROMPT_EOL_MARK=''",
      `export PATH="${bin}:$PATH" ALCHEMY_PROFILE=${profile} FORCE_HYPERLINK=1`,
      "unset CI CURSOR_AGENT CLAUDECODE CLAUDE_CODE NO_COLOR FORCE_COLOR",
      "",
    ].join("\n"),
  );
  await tmux("kill-server");
  const shell = `ZDOTDIR=${zdot} zsh -i`;
  await sh([
    "tmux",
    "-f",
    tmuxConf,
    "-L",
    SOCKET,
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-n",
    "deploy",
    "-x",
    String(cols),
    "-y",
    String(rows),
    "-c",
    dir,
    shell,
  ]);
  for (const tab of TABS.slice(1)) {
    await tmux("new-window", "-d", "-t", PANES[tab], "-n", tab, "-c", dir, shell);
  }
  await tmux("select-window", "-t", PANES.deploy);
  currentTab = "deploy";
  await Bun.sleep(800);
};

/** Poll until `alchemy dev` is ready and its output has been still for a moment. */
const waitDev = async (timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  let last = "";
  let stableSince = Date.now();
  for (;;) {
    const text = await paneText("dev");
    if (text !== last) {
      last = text;
      stableSince = Date.now();
    }
    const ready = /Dev stack ready \((\d+)\/\1\)/.test(
      text.trimEnd().split("\n").slice(-3).join("\n"),
    );
    if (ready && Date.now() - stableSince > 2500) return;
    if (Date.now() > deadline) throw new Error(`alchemy dev did not settle:\n${text.slice(-3000)}`);
    await Bun.sleep(300);
  }
};

/** Poll until `url` serves a page (fresh workers.dev hosts answer 404 for a few seconds). */
const waitForPage = async (url: string) => {
  for (let attempt = 0; attempt < 90; attempt++) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`${url} did not serve a page after 90s`);
};

/** Wait until the page's text matches `waitFor` (or has any text), then let it settle. */
const settlePage = async (view: Bun.WebView, url: string, waitFor?: RegExp) => {
  let text = "";
  for (let attempt = 0; attempt < 120; attempt++) {
    text = String(await view.evaluate("document.body ? document.body.innerText : ''"));
    if (waitFor ? waitFor.test(text) : text.length > 0) break;
    await Bun.sleep(250);
  }
  if (waitFor && !waitFor.test(text)) {
    throw new Error(`${url} never showed ${waitFor}; page text: ${text.slice(0, 500)}`);
  }
  await Bun.sleep(600);
};

/** The element's box in page (CSS) pixels, which is also the video's viewport coordinates. */
const boxOf = async (view: Bun.WebView, selector: string) => {
  const json = String(
    await view.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "";
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()`),
  );
  if (!json) throw new Error(`no element matches ${selector}`);
  return JSON.parse(json) as { x: number; y: number; width: number; height: number };
};

/** Window contents carried from scene to scene. */
let desk: Desk = { files: [], tabs: [], active: undefined, terminalTabs: [] };
const state: Record<string, string> = {};

const captureScene = async (id: string, scene: SceneDefinition) => {
  const out = path.join(captureRoot, id);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const chapter = path.join(chaptersDir, scene.chapter);

  const beats: Beat[] = [];
  const start: Desk = structuredClone({ ...desk, files: await listFiles(dir) });
  const tabs = new Map(desk.tabs.map((tab) => [tab.file, tab.content]));
  let active = desk.active;
  let browser = desk.browser;
  let diagram = desk.diagram;
  let terminalBeats = 0;
  /** Tabs used so far; "dev" in here means `alchemy dev` is running. */
  const openedTabs = new Set<Pane>(desk.terminalTabs ?? []);
  let shots = 0;
  /** One real browser tab per scene, driven like a user would. */
  let view: Bun.WebView | undefined;
  const shoot = async () => {
    const title = String(await view!.evaluate("document.title"));
    const png = (await view!.screenshot({ encoding: "buffer" })) as Uint8Array;
    const screenshot = `${id}/browser-${++shots}.png`;
    await Bun.write(path.join(captureRoot, screenshot), png);
    return { title, screenshot };
  };

  /** Edited text not yet on disk: intermediate edits never reach `alchemy dev`. */
  const pending = new Map<string, string>();
  const current = async (file: string) =>
    pending.get(file) ?? (await readText(path.join(dir, file)));
  const flush = async () => {
    for (const [file, content] of pending) await writeProjectFile(file, content);
    pending.clear();
  };

  const openTab = (file: string, content: string) => {
    tabs.set(file, content);
    active = file;
  };

  const writeProjectFile = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  };

  const video = defineVideo(
    {
      output: [path.join(out, "terminal.mp4")],
      cast: path.join(out, "terminal.cast"),
      cache: false,
      shell: "zsh",
      cwd: dir,
      width: TERMINAL.width,
      height: TERMINAL.height,
      scale: 1,
      fps: VIDEO.fps,
      margin: 0,
      padding: 14,
      windowBar: "none",
      borderRadius: 0,
      // Ghostty's defaults: its built-in dark theme and JetBrains Mono.
      theme: "ghostty-default-style-dark",
      font: { family: "JetBrains Mono", size: 16, lineHeight: 1.35 },
      cursor: { blink: false },
      typingSpeed: "40ms",
      typingJitter: 0.4,
      maxPause: "1.5s",
      waitTimeout: "300s",
      endPause: "0ms",
    },
    async (t: TerminalSession) => {
      await t.hide(async () => {
        await t.run("clear");
        await t.type(`tmux -L ${SOCKET} attach -t ${SESSION}`);
        await t.enter();
        await t.sleep("1500ms");
      });
      await t.marker(`${TAB}${currentTab}`);

      /**
       * Click over to a terminal tab (a tmux window). The tab marker is written
       * only once the recorded screen shows the new tab's content, so the tab
       * bar and the terminal can't disagree.
       */
      const showTab = async (pane: Pane) => {
        openedTabs.add(pane);
        if (pane === currentTab) return;
        const visible = (text: string) =>
          text
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n")
            .trimEnd();
        await tmux("select-window", "-t", PANES[pane]);
        const target = visible(await tmux("capture-pane", "-p", "-t", PANES[pane]));
        const deadline = Date.now() + 3_000;
        while (visible(t.screen()) !== target && Date.now() < deadline) await t.sleep("30ms");
        currentTab = pane;
        await t.marker(`${TAB}${pane}`);
        await t.sleep("700ms");
      };

      const term: Term = {
        async type(pane, command) {
          await showTab(pane);
          await t.sleep("300ms");
          // The whole command appears at once; typing it out only slows the talk down.
          await t.paste(command);
          await t.sleep("400ms");
          await t.enter();
        },
        async key(pane, key) {
          await tmux("send-keys", "-t", PANES[pane], key);
        },
        async run(tab, command, opts) {
          const prompts = (text: string) =>
            text.split("\n").filter((line) => /❯/.test(line)).length;
          const before = prompts(await paneText(tab));
          await term.type(tab, command);
          const deadline = Date.now() + (opts?.timeout ?? 120_000);
          for (;;) {
            const text = await paneText(tab);
            const lines = text.trimEnd().split("\n");
            // Finished once a fresh, empty prompt follows the command.
            const finished = opts?.until
              ? opts.until.test(text)
              : prompts(text) > before && /❯\s*$/.test(lines.at(-1) ?? "");
            if (finished) break;
            if (Date.now() > deadline)
              throw new Error(`\`${command}\` did not finish:\n${text.slice(-3000)}`);
            await Bun.sleep(300);
          }
          await t.sleep("1200ms");
          return paneText(tab);
        },
        async waitDev(opts) {
          // Watch alchemy dev pick up the change on its own tab.
          await showTab("dev");
          await waitDev(opts?.timeout);
        },
        waitFor: (pane, pattern, opts) => waitFor(pane, pattern, opts?.timeout),
        text: paneText,
        sleep: (ms) => t.sleep(`${ms}ms`),
      };

      const context: SceneContext = {
        dir,
        state,
        async chapterLines(file) {
          if (!(await exists(path.join(chapter, file))))
            throw new Error(`${scene.chapter} has no ${file}`);
          const lines = (await readText(path.join(chapter, file))).split("\n");
          return (from, to = from) => {
            if (from < 1 || to > lines.length || to < from)
              throw new Error(`${file} has no lines ${from}–${to}`);
            return `${lines.slice(from - 1, to).join("\n")}\n`;
          };
        },
        caption(text) {
          beats.push({ kind: "caption", text });
        },
        slide(heading, opts) {
          beats.push({ kind: "step", title: heading, notes: opts?.notes ?? opts?.subtitle ?? "" });
          beats.push({
            kind: "slide",
            layout: "section",
            props: { eyebrow: opts?.eyebrow, heading, subtitle: opts?.subtitle },
          });
        },
        step(title, notes) {
          beats.push({ kind: "step", title, notes: notes ?? "" });
        },
        async sync(opts) {
          const keep = new Set(opts?.except ?? []);
          const want = await listFiles(chapter);
          for (const file of await listFiles(dir)) {
            if (!want.includes(file) && !keep.has(file)) await rm(path.join(dir, file));
          }
          for (const file of want) {
            if (keep.has(file)) continue;
            await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
            await cp(path.join(chapter, file), path.join(dir, file));
            if (tabs.has(file)) tabs.set(file, await readText(path.join(dir, file)));
          }
        },
        editor: {
          async open(file) {
            const content = await current(file);
            openTab(file, content);
            beats.push({ kind: "editor.open", file, content });
          },
          async patch(file, title, edit, notes) {
            const before = await current(file);
            const after = edit(before);
            if (after === before) throw new Error(`patch "${title}" changed nothing in ${file}`);
            pending.set(file, after);
            openTab(file, after);
            beats.push({ kind: "step", title, notes: notes ?? "" });
            beats.push({ kind: "editor.patch", file, title, before, after });
          },
          async show(file, title) {
            if (!(await exists(path.join(chapter, file))))
              throw new Error(`${scene.chapter} has no ${file}`);
            const after = await readText(path.join(chapter, file));
            await context.editor.patch(file, title ?? file, () => after);
          },
          async remove(file) {
            pending.delete(file);
            await rm(path.join(dir, file), { force: true });
            tabs.delete(file);
            if (active === file) active = [...tabs.keys()].pop();
            beats.push({ kind: "editor.delete", file });
          },
        },
        async terminal(fn) {
          await flush();
          const index = terminalBeats++;
          beats.push({ kind: "terminal", start: 0, end: 0 });
          await t.marker(`${BEAT}start:${index}`);
          try {
            return await fn(term);
          } finally {
            await t.marker(`${BEAT}end:${index}`);
          }
        },
        async diagram(opts) {
          await flush();
          // Cut to the dev tab to watch alchemy dev pick up the change, then read the state it wrote.
          if (openedTabs.has("dev")) {
            await context.terminal(async (term) => {
              await term.waitDev();
              await term.sleep(1200);
            });
          }
          const stateDir = path.join(dir, ".alchemy", "state", "Shorty");
          const deadline = Date.now() + 120_000;
          let graph: Graph;
          for (;;) {
            graph = await readGraph(stateDir, opts.stage);
            const ids = new Set(graph.nodes.map((n) => n.id));
            const edges = new Set(graph.edges.map((e) => e.id));
            const missing = [
              ...(opts.nodes ?? []).filter((n) => !ids.has(n)),
              ...(opts.edges ?? []).filter((e) => !edges.has(e)),
            ];
            if (missing.length === 0) break;
            if (Date.now() > deadline)
              throw new Error(`diagram never showed ${missing.join(", ")}`);
            await Bun.sleep(500);
          }
          const previous = diagram;
          const oldNodes = new Set(previous?.nodes.map((n) => n.id) ?? []);
          const oldEdges = new Set(previous?.edges.map((e) => e.id) ?? []);
          beats.push({
            kind: "diagram",
            graph,
            addedNodes: graph.nodes.filter((n) => !oldNodes.has(n.id)).map((n) => n.id),
            addedEdges: graph.edges.filter((e) => !oldEdges.has(e.id)).map((e) => e.id),
          });
          diagram = graph;
        },
        browser: {
          async open(url, opts) {
            await flush();
            // Let alchemy dev pick up the latest code before the page loads.
            if (openedTabs.has("dev")) await waitDev();
            await waitForPage(url);
            view?.close();
            view = new Bun.WebView({ ...BROWSER_VIEWPORT, backend: "webkit" });
            await view.navigate(url);
            await settlePage(view, url, opts?.waitFor);
            const shot = await shoot();
            browser = { url, ...shot };
            beats.push({ kind: "browser", url, ...shot });
          },
          async update(opts) {
            if (!browser || !view) throw new Error("browser.update before browser.open");
            await view.navigate(browser.url);
            await settlePage(view, browser.url, opts.waitFor);
            const shot = await shoot();
            browser = { ...browser, ...shot };
            beats.push({ kind: "browser.update", ...shot });
          },
          async fill(selector, text) {
            if (!browser || !view) throw new Error("browser.fill before browser.open");
            const target = await boxOf(view, selector);
            // Set the value the way React sees user input.
            await view.evaluate(`(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              el.focus();
              const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
              set.call(el, ${JSON.stringify(text)});
              el.dispatchEvent(new Event("input", { bubbles: true }));
            })()`);
            await Bun.sleep(300);
            const shot = await shoot();
            browser = { ...browser, ...shot };
            beats.push({ kind: "browser.action", action: "fill", target, ...shot });
          },
          async click(selector, opts) {
            if (!browser || !view) throw new Error("browser.click before browser.open");
            const target = await boxOf(view, selector);
            await view.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
            await settlePage(view, browser.url, opts?.waitFor);
            const shot = await shoot();
            browser = { ...browser, ...shot };
            beats.push({ kind: "browser.action", action: "click", target, ...shot });
          },
        },
        focus(app) {
          beats.push({ kind: "focus", app });
        },
        pause(seconds) {
          beats.push({ kind: "pause", seconds });
        },
      };

      try {
        await scene.run(context);
      } finally {
        view?.close();
      }
      await flush();

      // The edits on screen must add up to the real, tested chapter.
      const want = await listFiles(chapter);
      const have = await listFiles(dir);
      const problems: string[] = [];
      for (const file of new Set([...want, ...have])) {
        if (!want.includes(file)) problems.push(`extra file ${file}`);
        else if (!have.includes(file)) problems.push(`missing file ${file}`);
        else if (
          (await readText(path.join(dir, file))) !== (await readText(path.join(chapter, file)))
        ) {
          problems.push(`${file} differs from chapters/${scene.chapter}/${file}`);
        }
      }
      if (problems.length > 0)
        throw new Error(`${id} did not end at its chapter:\n  ${problems.join("\n  ")}`);

      await t.hide(async () => {
        await tmux("detach-client", "-s", SESSION);
        await t.sleep("500ms");
      });
    },
  );

  // tmux resizes the window to the recording's terminal when it attaches.
  if (!(await hasSession())) await startTmux(150, 40);

  console.log(`● ${id}: recording`);
  const recording = await video.record({ force: true, log: (m) => console.log(`  ${m}`) });

  const capture: SceneCapture = {
    id,
    title: scene.title,
    notes: scene.notes ?? "",
    project,
    start,
    end: {
      files: await listFiles(dir),
      tabs: [...tabs].map(([file, content]) => ({ file, content })),
      active,
      browser,
      diagram,
      terminalTabs: [...openedTabs],
    },
    terminal: undefined,
    beats,
  };

  if (terminalBeats > 0) {
    const timeline = buildTimeline(recording.events, video.config.playbackSpeed, {
      maxPause: video.config.maxPause,
    });
    const at = new Map<string, number>();
    const tabTimeline: { at: number; tab: Pane }[] = [];
    for (const e of timeline.events) {
      if (e.type !== "m") continue;
      if (e.data.startsWith(BEAT)) at.set(e.data.slice(BEAT.length), e.vt);
      if (e.data.startsWith(TAB))
        tabTimeline.push({ at: e.vt, tab: e.data.slice(TAB.length) as Pane });
    }
    let index = 0;
    for (const beat of beats) {
      if (beat.kind !== "terminal") continue;
      beat.start = at.get(`start:${index}`) ?? 0;
      beat.end = at.get(`end:${index}`) ?? beat.start;
      index++;
    }
    console.log(`● ${id}: rendering the terminal`);
    const result = await video.render(recording);
    capture.terminal = {
      clip: `${id}/terminal.mp4`,
      duration: result.durationSeconds,
      tabs: tabTimeline,
    };
  }

  desk = capture.end;
  await writeFile(path.join(out, "scene.json"), `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`✔ ${id}: ${beats.length} beats`);
};

const hasSession = async () =>
  (await Bun.spawn(["tmux", "-L", SOCKET, "has-session", "-t", SESSION], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited) === 0;

const teardown = async () => {
  await tmux("kill-server");
  if (args.keep) return;
  // Give `alchemy dev` a moment to exit, then remove what the talk created.
  await Bun.sleep(2_000);
  for (const stage of [`dev_${process.env.USER}`, "prod"]) {
    console.log(`● destroying the ${stage} stage`);
    const cmd = ["alchemy", "destroy", "--yes", "--profile", profile, "--stage", stage];
    const proc = Bun.spawn(cmd, {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: "" },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0)
      console.error(`✘ ${cmd.join(" ")} failed; run it by hand in work/${project}`);
  }
};

const scenes = deck.filter((item) => item.kind === "scene");
const selected = args.only ? scenes.filter((item) => item.id === args.only) : scenes;
if (selected.length === 0) throw new Error(`no scene ${args.only}`);

if (!args.only) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
} else {
  // Resume from the desk the previous scene left behind.
  const index = scenes.findIndex((item) => item.id === args.only);
  const previous = scenes[index - 1];
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (previous) {
    const prev = JSON.parse(
      await readText(path.join(captureRoot, previous.id, "scene.json")),
    ) as SceneCapture;
    desk = prev.end;
    const prevScene = (await import(path.join(root, "scenes", `${previous.id}.ts`)))
      .default as SceneDefinition;
    await cp(path.join(chaptersDir, prevScene.chapter), dir, {
      recursive: true,
      filter: (src) => !IGNORED.has(path.basename(src)),
    });
    // Later chapters expect `alchemy dev` already running in its tab.
    await startTmux(150, 40);
    if (desk.terminalTabs?.includes("dev")) {
      await tmux("send-keys", "-t", PANES.dev, "alchemy dev", "Enter");
      await waitDev(300_000);
      await tmux("send-keys", "-t", PANES.dev, "C-l");
    }
    currentTab = "deploy";
  }
}

try {
  for (const item of selected) {
    const scene = (await import(path.join(root, "scenes", `${item.id}.ts`)))
      .default as SceneDefinition;
    await captureScene(item.id, scene);
  }
} finally {
  await teardown();
}
