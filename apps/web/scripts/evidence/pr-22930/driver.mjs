// Playwright driver for the PR #22930 evidence rows. Runs the same steps against either build.
// usage: node driver.mjs <row> <out-dir>   (env: BASE_URL, ENV_ID, THREAD_A, STORAGE_STATE)
import { chromium } from "playwright";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const [row, outDir] = process.argv.slice(2);
const { BASE_URL, ENV_ID, THREAD_A, STORAGE_STATE } = process.env;
const ROWS = {
  R1: { w: 1440, h: 900, scheme: "light" },
  R2: { w: 1440, h: 900, scheme: "dark" },
  R3: { w: 1440, h: 900, scheme: "light" },
  R4: { w: 390, h: 844, scheme: "dark" },
  R5: { w: 1440, h: 900, scheme: "dark" },
  R6: { w: 1440, h: 900, scheme: "light" },
  R7: { w: 390, h: 844, scheme: "light" },
  R8: { w: 1440, h: 900, scheme: "dark" },
  S: { w: 1440, h: 900, scheme: "light" },
};
const cfg = { ...(ROWS[row.startsWith("S") ? "S" : row] ?? ROWS.R1) };
const still = row.startsWith("S"); // S-<w>-<scheme>
if (still) [, cfg.w, cfg.scheme] = row.split("-").map((v, i) => (i === 1 ? +v : v));
if (still) cfg.h = cfg.w === 390 ? 844 : 900;
NodeFS.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: cfg.w, height: cfg.h },
  deviceScaleFactor: 1,
  colorScheme: cfg.scheme,
  storageState: STORAGE_STATE,
  ...(still ? {} : { recordVideo: { dir: outDir, size: { width: cfg.w, height: cfg.h } } }),
});
// The provider "Update available" toast lands over the PR header in both builds; hide it identically.
await ctx.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = '[data-slot="toast-portal"]{display:none!important}';
    document.head.append(style);
  });
});
await ctx.addInitScript(DOM_HELPERS);
const page = await ctx.newPage();
const t0 = Date.now();
const events = [];
const threadUrl = (id) => `${BASE_URL}/${ENV_ID}/${encodeURIComponent(id)}`;

// The diff viewer renders file headers inside shadow roots, so queries walk them explicitly.
function DOM_HELPERS() {
  const deepAll = (sel, root = document, out = []) => {
    out.push(...root.querySelectorAll(sel));
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) deepAll(sel, el.shadowRoot, out);
    return out;
  };
  const scrollerOf = (node) => {
    for (let n = node; n; n = n.parentNode ?? n.host) {
      if (n instanceof HTMLElement && n.classList?.contains("overflow-auto")) return n;
    }
    return null;
  };
  window.__ev = { deepAll, scrollerOf };
}
async function state() {
  return page.evaluate(() => {
    const { deepAll, scrollerOf } = window.__ev;
    const headers = deepAll("[data-diffs-header]");
    const scroller = headers.length ? scrollerOf(headers[0]) : null;
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const foldButtons = deepAll(
      'button[aria-label="Expand diff"], button[aria-label="Collapse diff"]',
    );
    const scope =
      document.querySelector('[aria-label^="Diff scope:"]')?.getAttribute("aria-label") ?? null;
    const files = headers
      .map((h) => {
        const hy = h.getBoundingClientRect().top;
        const b = foldButtons.find((x) => Math.abs(x.getBoundingClientRect().top - hy) < 20);
        return {
          path: h.querySelector("[data-title]")?.textContent?.trim(),
          collapsed: b ? b.getAttribute("aria-label") === "Expand diff" : null,
          y: Math.round(h.getBoundingClientRect().top - top),
        };
      })
      .filter((f) => f.path && f.y > -2000 && f.y < 3000)
      .sort((a, b) => a.y - b.y);
    const line = deepAll("[data-line]").find((l) => {
      const r = l.getBoundingClientRect();
      return r.height > 0 && r.top >= top + 40;
    });
    return {
      scope,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      scrollHeight: scroller?.scrollHeight ?? null,
      files,
      firstLine: line ? line.textContent.trim().slice(0, 60) : null,
      codeVisible: !!scroller && scroller.getBoundingClientRect().height > 0,
    };
  });
}
async function log(label) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const s = await state();
  const e = { t: +((Date.now() - t0) / 1000).toFixed(2), label, ...s };
  events.push(e);
  console.log(JSON.stringify(e));
  return s;
}
const settle = (ms = 2500) => page.waitForTimeout(ms);
const btn = (name) => page.getByRole("button", { name, exact: true }).locator("visible=true");

async function openThread(id, title) {
  await page.goto(threadUrl(id));
  await page.getByText(title).first().waitFor({ timeout: 120000 });
  await settle(1500);
  await dismissToasts();
}
async function dismissToasts() {
  for (const b of await page.getByRole("button", { name: "Dismiss notification" }).all())
    await b.click().catch(() => {});
}
async function openPrPanel(n) {
  if (
    !(await btn("Code")
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    const link = page
      .locator(`a[href$="/pulls/${n}"]:visible, button:has-text("fixture/revie"):visible`)
      .first();
    // Narrow layouts hide the thread details panel that holds the PR link.
    if (!(await link.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Toggle thread details panel" }).first().click();
      await settle(800);
      await page
        .getByText(n === 1 ? "L: long review fixture" : "S: short review fixture")
        .locator("visible=true")
        .first()
        .click();
    } else await link.click();
  }
  await btn("Code").first().waitFor({ timeout: 60000 });
}
// In-app navigation keeps the client store alive; a URL load would reset it in both builds.
async function goThread(title) {
  const item = page.getByText(title, { exact: true }).locator("visible=true").first();
  if (!(await item.isVisible().catch(() => false))) {
    // On narrow layouts the PR sheet covers the header; close it (Escape) to reach the sidebar.
    const toggle = page
      .getByRole("button", { name: "Toggle main sidebar" })
      .locator("visible=true")
      .first();
    if (!(await toggle.isVisible().catch(() => false))) await page.keyboard.press("Escape");
    await toggle.click();
  }
  await item.click();
  await settle(2000);
}
async function codeTab() {
  await dismissToasts();
  await btn("Code").first().click();
  await page.locator("[data-diffs-header]").first().waitFor({ timeout: 60000 });
  await settle();
}
async function header(path) {
  return page
    .locator("[data-diffs-header]")
    .filter({ has: page.locator("[data-title]", { hasText: path }) })
    .first();
}
async function setFold(path, collapsed) {
  const h = await header(path);
  await h.scrollIntoViewIfNeeded();
  await settle(300);
  // The fold button is rendered outside the header's shadow root; match it by row position.
  const clicked = await h.evaluate((el, want) => {
    const hy = el.getBoundingClientRect().top;
    const b = window.__ev
      .deepAll('button[aria-label="Expand diff"], button[aria-label="Collapse diff"]')
      .find((x) => Math.abs(x.getBoundingClientRect().top - hy) < 20);
    if (!b) return "missing";
    if ((b.getAttribute("aria-label") === "Expand diff") === want) return "unchanged";
    b.click();
    return "clicked";
  }, collapsed);
  if (clicked === "missing") throw new Error(`no fold button for ${path}`);
  await settle(600);
}
async function collapseAll() {
  const b = page.getByRole("button", { name: "Collapse all files" });
  if (await b.isVisible().catch(() => false)) await b.click();
  await settle(800);
}
async function scrollViewer(target = 3000) {
  const box = await page
    .locator("[data-diffs-header]")
    .first()
    .evaluate((h) => {
      const r = window.__ev.scrollerOf(h).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < 40; i++) {
    const top = (await state()).scrollTop ?? 0;
    if (top >= target - 20) break;
    await page.mouse.wheel(0, Math.min(400, target - top));
    await page.waitForTimeout(120);
  }
  await settle(800);
  await page.mouse.move(2, 2); // park outside the viewer so no input cancels a restore
}
async function selectCommit(label) {
  await page.locator('[aria-label^="Diff scope:"]').click();
  await page.getByRole("menuitemradio").filter({ hasText: label }).first().click();
  await page.locator("[data-diffs-header]").first().waitFor({ timeout: 60000 });
  await settle();
}
async function refreshFromHeader() {
  await page.getByRole("button", { name: "More pull request actions" }).first().click();
  await page
    .getByRole("menuitem", { name: /refresh/i })
    .first()
    .click();
}
// Prelude P from the matrix. `full=false` stops after step 3 (All commits).
async function prelude(full = true) {
  await openThread(THREAD_A, "Thread A");
  await openPrPanel(1);
  await codeTab();
  await log("P1 Code tab, All commits");
  await collapseAll();
  // renamed.ts first: once long-b.ts expands, the viewer virtualizes the later headers away.
  await setFold("renamed.ts", false);
  await setFold("long-b.ts", false);
  await log("P2 collapse all, expand long-b.ts + renamed.ts");
  await scrollViewer();
  await log("P3 scrolled to mid long-b.ts");
  if (!full) return;
  await selectCommit("C2:");
  await log("P4 selected C2 (both builds reset here)");
  await collapseAll();
  // renamed.ts first: once long-b.ts expands, the viewer virtualizes the later headers away.
  await setFold("renamed.ts", false);
  await setFold("long-b.ts", false);
  await log("P5 mixed fold in C2 (short-2.json, long-c.md collapsed)");
  await scrollViewer();
  await log("P6 scrolled to mid long-b.ts in C2");
}

const rows = {
  async probe() {
    await prelude(false);
  },
  async R1() {
    await prelude(false);
    const sha = NodeChildProcess.execFileSync(NodePath.join(here, "push-c4.sh"), ["--external"])
      .toString()
      .trim();
    await log(`T push C4 ${sha.slice(0, 7)} (git push)`);
    // The in-app Push button is replaced by Merge once the branch has a PR, so the trigger that
    // makes the client see the new revision is the header Refresh (it invalidates the host cache).
    await refreshFromHeader();
    await page
      .getByText("C4: new push")
      .first()
      .waitFor({ timeout: 60000, state: "attached" })
      .catch(() => {});
    await settle(4000);
    await log("A after Refresh picked up C4");
    await settle(4000);
    await log("A +4s at rest");
  },
  async R2() {
    await prelude(true);
    const sha = NodeChildProcess.execFileSync(NodePath.join(here, "push-c4.sh"), ["--external"])
      .toString()
      .trim();
    await log(`T push C4 ${sha.slice(0, 7)} (git push), waiting 65s for the 60s host cache`);
    await page.waitForTimeout(65000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(6000);
    await log("A after blur+focus live refresh");
    await settle(4000);
    await log("A +4s at rest");
  },
  async R3() {
    await prelude(true);
    const other = await ctx.newPage();
    await other.goto(`${BASE_URL}/pull-requests`);
    await other.getByText("L: long review fixture").first().click({ timeout: 120000 });
    await other
      .getByRole("button", { name: "More pull request actions" })
      .first()
      .click({ timeout: 60000 });
    await other
      .getByRole("menuitem", { name: /refresh/i })
      .first()
      .click();
    await other.waitForTimeout(4000);
    await other.close();
    await page.bringToFront();
    await log("T Refresh in a second tab (/pull-requests), background epoch only");
    await settle(4000);
    await log("A +4s at rest");
  },
  async R4() {
    await prelude(true);
    await refreshFromHeader();
    await log("T header menu Refresh");
    await settle(4000);
    await log("A +4s at rest");
  },
  async R5() {
    await prelude(true);
    for (const tab of ["Summary", "Timeline", "Guide"]) {
      if (
        !(await btn(tab)
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        await log(`T ${tab} tab not offered`);
        continue;
      }
      await btn(tab).first().click();
      await settle(1500);
      await btn("Code").first().click();
      await settle(2500);
      await log(`A Code -> ${tab} -> Code`);
    }
  },
  async R6() {
    await prelude(true);
    await page.getByRole("button", { name: "Toggle right panel" }).first().click();
    await settle(1500);
    await page.getByRole("button", { name: "Toggle right panel" }).first().click();
    await settle(3000);
    if (
      !(await page
        .locator("[data-diffs-header]")
        .first()
        .isVisible()
        .catch(() => false))
    )
      await btn("Code")
        .first()
        .click()
        .catch(() => {});
    await settle(2500);
    await log("A (a) right panel hidden and shown");
    await page
      .getByRole("button", { name: /^Close #1/ })
      .first()
      .click();
    await settle(1500);
    await openPrPanel(1);
    await settle(1500);
    await log("T (b) PR surface closed and reopened from the thread link");
    await btn("Code").first().click();
    await page.locator("[data-diffs-header]").first().waitFor({ timeout: 60000 });
    await settle(2500);
    await log("A (b) Code tab after reopen");
  },
  async R7() {
    await prelude(true);
    await goThread("Thread B");
    await openPrPanel(2);
    await codeTab();
    await log("B1 thread B, PR #2 Code tab");
    await selectCommit("S2:");
    await collapseAll();
    await setFold("s-4.txt", false);
    await scrollViewer(5000);
    await log("B2 thread B: S2 selected, s-4 expanded, s-5 collapsed, scrolled to bottom");
    for (const [title, label] of [
      ["Thread A", "A back to thread A"],
      ["Thread B", "A back to thread B"],
    ]) {
      await goThread(title);
      if (
        !(await page
          .locator("[data-diffs-header]")
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        if (
          !(await btn("Code")
            .first()
            .isVisible()
            .catch(() => false))
        )
          await openPrPanel(title === "Thread A" ? 1 : 2);
        await btn("Code").first().click();
      }
      await page.locator("[data-diffs-header]").first().waitFor({ timeout: 60000 });
      await settle(2500);
      await log(label);
    }
  },
  async R8() {
    await prelude(false);
    await selectCommit("C2:");
    await log("T selected C2");
    await selectCommit("All commits");
    await log("A back to All commits");
    await page.reload();
    await openPrPanel(1).catch(() => {});
    await btn("Code")
      .first()
      .click()
      .catch(() => {});
    await page
      .locator("[data-diffs-header]")
      .first()
      .waitFor({ timeout: 90000 })
      .catch(() => {});
    await settle(3000);
    await log("A after page reload");
  },
  async still() {
    await prelude(true);
    await refreshFromHeader();
    await settle(5000);
    await page.mouse.move(2, 2);
    await log("A at rest after Refresh");
    await page.screenshot({ path: NodePath.join(outDir, `${row}.png`) });
  },
};

try {
  await (still ? rows.still : rows[row])();
} catch (error) {
  events.push({
    t: +((Date.now() - t0) / 1000).toFixed(2),
    label: `ERROR ${String(error.message).split("\n")[0]}`,
  });
  console.error(error);
  await page.screenshot({ path: NodePath.join(outDir, `${row}-error.png`) }).catch(() => {});
} finally {
  const video = page.video();
  await ctx.close();
  if (video) NodeFS.writeFileSync(NodePath.join(outDir, `${row}.video-path`), await video.path());
  NodeFS.writeFileSync(
    NodePath.join(outDir, `${row}.events.json`),
    JSON.stringify({ row, cfg, events }, null, 2),
  );
  await browser.close();
}
