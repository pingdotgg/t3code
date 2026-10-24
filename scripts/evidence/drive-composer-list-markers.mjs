#!/usr/bin/env node
// Drives the rich-text chat composer through the list-marker fixtures of PR #22997
// (late-completed Markdown list markers) and records a self-narrating video plus a
// per-step log, so the same keystrokes can be compared on two revisions.
//
// Run against a dev server that is already paired (see `vp run dev` and its pairingUrl):
//
//   PLAYWRIGHT_MODULE=<repo>/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs \
//   node drive-composer-list-markers.mjs \
//     --base-url http://localhost:5733 --label after --viewport 1440 --theme light \
//     --rows F1,F2,F6 --storage-state ./state-after.json --out-dir ./out [--pair-url <url>] \
//     [--stills F1,F14] [--no-video]
//
// --pair-url pairs a fresh browser and writes --storage-state; later runs reuse it.
// Outputs, per run: <label>-<viewport>-<theme>-<tag>.webm/.mp4 (trimmed to the first step),
// a .json and .md step log with offsets from the start of the trimmed video, and, for rows
// listed in --stills, a full-page PNG of the row's end state taken under a frozen clock.
// Never presses plain Enter or Mod+Enter: both send the message.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (!arg.startsWith("--")) return acc;
    const next = all[i + 1];
    acc.push([arg.slice(2), next === undefined || next.startsWith("--") ? true : next]);
    return acc;
  }, []),
);
const baseUrl = String(args["base-url"] ?? "").replace(/\/$/, "");
const label = String(args.label ?? "run");
const viewportWidth = Number(args.viewport ?? 1440);
const theme = args.theme === "dark" ? "dark" : "light";
const rowIds = String(args.rows ?? "F1")
  .split(",")
  .filter(Boolean);
const stillRows = new Set(
  String(args.stills ?? "")
    .split(",")
    .filter(Boolean),
);
const outDir = NodePath.resolve(String(args["out-dir"] ?? "./out"));
const storageState = NodePath.resolve(String(args["storage-state"] ?? `./state-${label}.json`));
const recordVideo = !args["no-video"];
const tag = String(args.tag ?? rowIds.join("-"));
const FROZEN_TIME = new Date("2026-10-22T12:00:00Z");
const EDITOR = '[data-testid="composer-editor"]';
const DRAFT_KEY = "t3code:composer-drafts:v1";
const FONT_PREVIEW = '[data-testid="composer-editor"][aria-label="Prompt font preview"]';
let editorSel = EDITOR;
if (!baseUrl) throw new Error("--base-url is required");
NodeFS.mkdirSync(outDir, { recursive: true });

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch();
const viewport = { width: viewportWidth, height: viewportWidth <= 500 ? 844 : 900 };

if (args["pair-url"]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(String(args["pair-url"]));
  await page.waitForURL((u) => !u.pathname.startsWith("/pair"), { timeout: 180_000 });
  await ctx.storageState({ path: storageState });
  await ctx.close();
}

const base = `${label}-${viewportWidth}-${theme}-${tag}`;
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
  colorScheme: theme,
  storageState,
  permissions: ["clipboard-read", "clipboard-write"],
  ...(recordVideo
    ? { recordVideo: { dir: NodePath.join(outDir, `.raw-${base}`), size: viewport } }
    : {}),
});
await context.addInitScript(() => {
  window.__caption = (text) => {
    let el = document.getElementById("__ev_caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__ev_caption";
      el.style.cssText =
        "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "pointer-events:none;max-width:92vw;padding:6px 12px;border-radius:8px;" +
        "font:600 13px/1.35 ui-monospace,monospace;background:#111c;color:#fff;" +
        "white-space:pre-wrap;box-shadow:0 2px 8px #0005";
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
  };
});
const page = await context.newPage();
await page.clock.install({ time: FROZEN_TIME });
const videoStart = Date.now();
const steps = [];
let t0 = null;
let currentRow = "";

const offset = () => ((Date.now() - (t0 ?? Date.now())) / 1000).toFixed(2);
async function caption(text) {
  await page.evaluate((t) => window.__caption?.(t), text).catch(() => {});
}
async function step(text, fn) {
  await caption(`${label.toUpperCase()} · ${currentRow} · ${text}`);
  steps.push({ row: currentRow, t: Number(offset()), step: text });
  await page.waitForTimeout(350);
  if (fn) await fn();
  await page.waitForTimeout(450);
}
const type = (text) =>
  step(`type ${JSON.stringify(text)}`, () => page.keyboard.type(text, { delay: 70 }));
const press = (key, times = 1) =>
  step(times > 1 ? `${key} ×${times}` : key, async () => {
    for (let i = 0; i < times; i++) await page.keyboard.press(key);
  });
const pause = (ms = 1100) =>
  step(`pause ${ms} ms (undo group boundary)`, () => page.waitForTimeout(ms));
const paste = (text) =>
  step(`paste ${JSON.stringify(text)}`, async () => {
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press("Control+V");
  });
const cdpInsert = (text) =>
  step(`CDP Input.insertText ${JSON.stringify(text)}`, async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.insertText", { text });
    await cdp.detach();
  });

async function waitForComposer() {
  await page.waitForSelector(EDITOR, { timeout: 240_000 });
  await page.waitForTimeout(1500);
}
async function focusComposer() {
  await page.locator(editorSel).first().click();
}
async function reset() {
  await step("reset composer (Ctrl+A, Backspace)", async () => {
    await focusComposer();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  });
}

// Structure of the composer document plus the persisted draft Markdown.
async function observe(note = "observe") {
  await page.waitForTimeout(500);
  const state = await page.evaluate(
    ({ sel, key }) => {
      const root = document.querySelector(sel);
      const describe = (node) => {
        const tagName = node.tagName.toLowerCase();
        if (tagName === "ul" || tagName === "ol") {
          const kind = node.getAttribute("data-type") === "taskList" ? "taskList" : tagName;
          const start = node.getAttribute("start");
          const items = [...node.children].map((li) => {
            const marker = li.getAttribute("data-marker");
            const checked = li.getAttribute("data-checked");
            return `li${marker ? `[marker=${JSON.stringify(marker)}]` : ""}${checked ? `[checked=${checked}]` : ""} ${JSON.stringify(li.textContent)}`;
          });
          return `${kind}${start ? `[start=${start}]` : ""}{ ${items.join("; ")} }`;
        }
        if (tagName === "p") return `p ${JSON.stringify(node.textContent)}`;
        return `${tagName} ${JSON.stringify(node.textContent)}`;
      };
      const structure = root ? [...root.children].map(describe) : ["<no composer>"];
      const prompts = [];
      const walk = (v) => {
        if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            if (k === "prompt" && typeof x === "string" && x) prompts.push(x);
            else walk(x);
          }
        }
      };
      try {
        walk(JSON.parse(localStorage.getItem(key) ?? "null"));
      } catch {}
      const toasts = document.querySelectorAll('[data-sonner-toast], [role="alert"]').length;
      return {
        structure,
        draftMarkdown: prompts,
        focused: !!root?.contains(document.activeElement),
        toasts,
      };
    },
    { sel: editorSel, key: DRAFT_KEY },
  );
  steps.push({ row: currentRow, t: Number(offset()), step: `${note}`, ...state });
  await caption(`${label.toUpperCase()} · ${currentRow} · ${note}: ${state.structure.join(" | ")}`);
  await page.waitForTimeout(900);
  return state;
}
async function still(name) {
  const file = NodePath.join(outDir, `${label}-${viewportWidth}-${theme}-${name}.png`);
  await caption("");
  await page.evaluate(() => document.getElementById("__ev_caption")?.remove());
  await page
    .locator(EDITOR)
    .evaluate((el) => el.blur())
    .catch(() => {});
  await page.clock.pauseAt(FROZEN_TIME.getTime() + 60_000).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage: true });
  await page.clock.resume().catch(() => {});
  steps.push({ row: currentRow, t: Number(offset()), step: `still ${NodePath.basename(file)}` });
}
async function reload() {
  await step("reload page", async () => {
    await page.reload();
    await waitForComposer();
  });
}
async function setRichText(on) {
  await step(`Settings → rich text composer ${on ? "ON" : "OFF"}, back to thread`, async () => {
    const threadUrl = page.url();
    await page.evaluate(() => {
      history.pushState({}, "", "/settings/general");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    const toggle = page.getByRole("switch", { name: "Rich text composer" });
    await toggle.waitFor({ timeout: 30_000 });
    if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
    await page.waitForTimeout(600);
    await page.evaluate((u) => {
      history.pushState({}, "", u);
      dispatchEvent(new PopStateEvent("popstate"));
    }, new URL(threadUrl).pathname);
    await waitForComposer();
  });
}
async function switchThreadAndBack() {
  await step("switch to another thread and back", async () => {
    const threadPath = new URL(page.url()).pathname;
    const settled = page.getByText(/^Settled/).first();
    if (await settled.isVisible().catch(() => false)) await settled.click();
    const rows = page.locator('[data-testid="sidebar-row-slim"], [data-testid="sidebar-row-card"]');
    const count = await rows.count();
    for (let i = count - 1; i >= 0; i--) {
      await rows.nth(i).click();
      await page.waitForTimeout(800);
      if (new URL(page.url()).pathname !== threadPath) break;
    }
    steps.push({
      row: currentRow,
      t: Number(offset()),
      step: `  on ${new URL(page.url()).pathname}`,
    });
    await page.waitForTimeout(800);
    await page.evaluate((u) => {
      history.pushState({}, "", u);
      dispatchEvent(new PopStateEvent("popstate"));
    }, threadPath);
    await waitForComposer();
  });
}

async function f1Keys() {
  await type("-existing text");
  await press("Shift+Enter");
  await type("second line");
  await press("Control+Home");
  await press("ArrowRight");
  await pause();
  await press("Space");
  await observe("after Space");
  await press("Control+End");
}

const ROWS = {
  F1: async () => {
    await reset();
    await f1Keys();
    await observe("end");
  },
  F2: async () => {
    for (const marker of ["*", "+"]) {
      await reset();
      await type(" existing");
      await press("Home");
      await type(marker);
      await observe(`end ${marker}`);
    }
    await reset();
    await type(" existing");
    await press("Home");
    await type("1");
    await observe("after 1 alone");
    await type(")");
    await observe("end 1)");
  },
  "F2-ctrl": async () => {
    for (const marker of ["*", "+", "1.", "1)"]) {
      await reset();
      await type(`${marker}existing`);
      await press("Home");
      await press("ArrowRight", marker.length);
      await press("Space");
      await observe(`end ${marker}`);
    }
  },
  F3: async () => {
    for (const digit of ["3", "1"]) {
      await reset();
      await type(" existing");
      await press("Home");
      await type(digit);
      await type(".");
      await observe(`end ${digit}.`);
    }
  },
  F4: async () => {
    await reset();
    await type("*x existing");
    await press("Home");
    await press("ArrowRight");
    await press("Delete");
    await observe("end");
  },
  F5: async () => {
    for (const box of ["[ ]", "[x]"]) {
      await reset();
      await type(`-${box} existing`);
      await press("Home");
      await press("ArrowRight");
      await press("Space");
      await observe(`end (a) ${box}`);
    }
    await reset();
    await type("other");
    await press("Home");
    await press("Shift+Enter");
    await press("ArrowUp");
    await type("- [ ]");
    await observe("(b) caret on line");
    await press("ArrowDown");
    await observe("(b) after ArrowDown");
  },
  F6: async () => {
    await reset();
    await f1Keys();
    await pause();
    await press("Control+Z");
    await observe("after undo");
    await pause();
    await press("Control+Shift+Z");
    await observe("after redo");
    await pause();
    await press("Control+Z");
    await observe("after second undo");
  },
  F7: async () => {
    await reset();
    await type("- ");
    await observe("(a) after '- '");
    await type("x");
    await observe("(a) end");
    await reset();
    for (const ch of ["- [", "x", "]"]) {
      await type(ch);
      await observe(`(b) after ${JSON.stringify(ch)}`);
    }
    await press("Space");
    await observe("(b) end");
    await reset();
    await type("- [l");
    await observe("(c) after '- [l'");
    await type("ink](url)");
    await observe("(c) end");
    await reset();
    await type("- [ ]x");
    await observe("(d) end");
    await reset();
    await type("-");
    await press("ArrowRight");
    await observe("(e) end");
  },
  F8: async () => {
    await reset();
    await type("other");
    await press("Home");
    await press("Shift+Enter");
    await press("ArrowUp");
    await type("- ");
    await observe("run 1 caret on '- '");
    await press("ArrowDown");
    await observe("run 1 end");
    await reset();
    await type("other");
    await press("Home");
    await press("Shift+Enter");
    await press("ArrowUp");
    await type("- ");
    await press("Home");
    await press("Shift+Enter");
    await observe("run 2 after split");
    await press("ArrowUp");
    await observe("run 2 end");
  },
  "F8-E1": async () => {
    await reset();
    await type("- ");
    await press("Shift+Enter");
    await observe("end");
  },
  F9: async () => {
    for (const marker of ["- ", "* ", "1. ", "1) ", "- [ ] "]) {
      await reset();
      await type("existing text");
      await press("Home");
      await paste(marker);
      await observe(`(a) pasted ${JSON.stringify(marker)}`);
      await press("Control+Z");
      await observe("(a) after undo");
    }
    for (const [sub, spaces] of [
      ["b", " "],
      ["c", "  "],
    ]) {
      await reset();
      await type("-existing");
      await press("Home");
      await press("ArrowRight");
      await pause();
      await paste(spaces);
      await observe(`(${sub}) after paste`);
      await pause();
      await press("Control+Z");
      await observe(`(${sub}) after undo`);
      await pause();
      await press("Control+Shift+Z");
      await observe(`(${sub}) after redo`);
    }
  },
  F10: async () => {
    await reset();
    await type("text more");
    await press("ArrowLeft", 4);
    await type("- ");
    await observe("(a) end");
    await reset();
    await type("a - b");
    await observe("(b) end");
    await reset();
    await type("  - x");
    await observe("(c) end");
    await reset();
    await cdpInsert("\t");
    await type("1. x");
    await observe("(d) end");
  },
  F11: async () => {
    await reset();
    await type("**-**existing");
    await press("Home");
    await press("ArrowRight");
    await press("Space");
    await observe("(a) end");
    await reset();
    await type("`-`existing");
    await press("Home");
    await press("ArrowRight");
    await press("Space");
    await observe("(b) end");
    await reset();
    await type("**- x**");
    await observe("(c) typed");
    await reload();
    await focusComposer();
    await press("Control+End");
    await type(" y");
    await observe("(c) after reload + typing");
  },
  F12: async () => {
    const cases = [
      ["a", async () => type("- outer")],
      ["b", async () => type("> quoted")],
      ["d", async () => type("# Title")],
    ];
    for (const [sub, setup] of cases) {
      await reset();
      await setup();
      await press("Home");
      await type("- ");
      await observe(`(${sub}) end`);
    }
    await reset();
    await type("```");
    await press("Shift+Enter");
    await type("- x");
    await observe("(c) end");
  },
  F13: async () => {
    await reset();
    await type("second");
    await press("Home");
    await press("Shift+Enter");
    await press("ArrowUp");
    await type("- ");
    await pause();
    await type("x");
    await observe("after x");
    await pause();
    await press("Control+Z");
    await observe("after undo");
    await press("ArrowDown");
    await press("End");
    await type(" edit");
    await observe("end");
  },
  F14: async () => {
    await reset();
    await f1Keys();
    await observe("converted state");
    await switchThreadAndBack();
    await observe("(a) after thread switch");
    await reload();
    await observe("(b) after reload");
    if (stillRows.has("F14")) await still("F14-after-reload");
    await setRichText(false);
    await observe("(c) rich text OFF");
    await setRichText(true);
    await observe("(c) rich text ON again");
  },
  F15: async () => {
    await reset();
    await step("attach compositionstart/compositionend listeners", () =>
      page.evaluate((sel) => {
        window.__compositionEvents = [];
        const root = document.querySelector(sel);
        for (const name of ["compositionstart", "compositionupdate", "compositionend"])
          root.addEventListener(name, (e) => window.__compositionEvents.push(`${name}:${e.data}`));
      }, EDITOR),
    );
    const cdp = await context.newCDPSession(page);
    await step('CDP Input.imeSetComposition "- にほんご"', () =>
      cdp.send("Input.imeSetComposition", {
        text: "- にほんご",
        selectionStart: 6,
        selectionEnd: 6,
      }),
    );
    await observe("composing");
    await step('CDP Input.imeSetComposition "- 日本語"', () =>
      cdp.send("Input.imeSetComposition", { text: "- 日本語", selectionStart: 5, selectionEnd: 5 }),
    );
    await step('CDP Input.insertText "- 日本語" (commit)', () =>
      cdp.send("Input.insertText", { text: "- 日本語" }),
    );
    await observe("right after commit");
    const events = await page.evaluate(() => window.__compositionEvents);
    steps.push({ row: currentRow, t: Number(offset()), step: "composition events", events });
    await pause();
    await press("End");
    await observe("after End");
    await press("Control+Z");
    await observe("after undo");
    await cdp.detach();
  },
  F16b: async () => {
    const threadPath = new URL(page.url()).pathname;
    await step("open Settings → Appearance (prompt font preview editor)", async () => {
      await page.evaluate(() => {
        history.pushState({}, "", "/settings/appearance");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.locator(FONT_PREVIEW).waitFor({ timeout: 30_000 });
      await page.locator(FONT_PREVIEW).scrollIntoViewIfNeeded();
    });
    editorSel = FONT_PREVIEW;
    try {
      await reset();
      await f1Keys();
      await observe("end (font preview editor)");
    } finally {
      editorSel = EDITOR;
      await page.evaluate((u) => {
        history.pushState({}, "", u);
        dispatchEvent(new PopStateEvent("popstate"));
      }, threadPath);
      await waitForComposer();
    }
  },
  F16a: async () => {
    await setRichText(false);
    await focusComposer();
    await reset();
    await f1Keys();
    await observe("end (rich text OFF)");
    await setRichText(true);
  },
};

let failed = null;
try {
  await page.goto(`${baseUrl}/`);
  await waitForComposer();
  const toastClose = page.locator("[data-sonner-toast] button[aria-label*='lose']");
  if (await toastClose.count())
    await toastClose
      .first()
      .click()
      .catch(() => {});
  t0 = Date.now();
  steps.push({ row: "-", t: 0, step: `thread ${new URL(page.url()).pathname}` });
  for (const id of rowIds) {
    currentRow = id;
    const run = ROWS[id];
    if (!run) throw new Error(`unknown row ${id}`);
    steps.push({ row: id, t: Number(offset()), step: "ROW START" });
    try {
      await run();
      if (stillRows.has(id) && id !== "F14") await still(`${id}-end`);
    } catch (error) {
      steps.push({ row: id, t: Number(offset()), step: `ERROR ${String(error).split("\n")[0]}` });
    }
  }
  await caption(`${label.toUpperCase()} · done`);
  await page.waitForTimeout(800);
} catch (error) {
  failed = error;
} finally {
  // Clear the composer so a leftover draft never sits in the thread.
  await page
    .locator(EDITOR)
    .click()
    .catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  const video = page.video();
  await context.close();
  await browser.close();
  const log = {
    label,
    viewport,
    theme,
    url: baseUrl,
    frozenClock: FROZEN_TIME.toISOString(),
    rows: rowIds,
    steps,
  };
  NodeFS.writeFileSync(NodePath.join(outDir, `${base}.steps.json`), JSON.stringify(log, null, 2));
  const md = [
    `# ${base}`,
    "",
    "| row | t (s) | step | structure | draft Markdown |",
    "|---|---|---|---|---|",
    ...steps.map(
      (s) =>
        `| ${s.row} | ${s.t.toFixed(2)} | ${s.step.replace(/\|/g, "\\|")}${s.events ? ` ${JSON.stringify(s.events)}` : ""} | ${(s.structure ?? []).join(" ⏎ ").replace(/\|/g, "\\|")} | ${s.draftMarkdown ? JSON.stringify(s.draftMarkdown).replace(/\|/g, "\\|") : ""} |`,
    ),
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(outDir, `${base}.steps.md`), md + "\n");
  if (video && t0) {
    const raw = await video.path();
    const trimStart = ((t0 - videoStart) / 1000).toFixed(2);
    NodeChildProcess.execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      trimStart,
      "-i",
      raw,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-movflags",
      "+faststart",
      NodePath.join(outDir, `${base}.mp4`),
    ]);
    NodeFS.rmSync(NodePath.dirname(raw), { recursive: true, force: true });
  }
  if (failed) throw failed;
}
