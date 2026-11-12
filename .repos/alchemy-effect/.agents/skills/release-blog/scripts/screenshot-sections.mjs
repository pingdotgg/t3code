import { readFileSync } from "node:fs";
// Screenshot sections of a release post for tweets.
//
//   bun screenshot-sections.mjs <post-url> <out-dir> <shots.json>
//
// shots.json maps an image name to the blocks to keep, in order:
//
//   { "01-effect-41": [["effect-41", "h"], ["effect-41", 1], ["effect-41", 3]] }
//
// Each entry is [heading id, "h" | n]: "h" is the heading itself, n is the
// n-th top-level block after it (0-based, counting paragraphs). Every other
// block on the page is hidden, so the image shows the heading and its code,
// diagram or table without the prose between them. Run with --list to print
// each heading's blocks and their indexes.
import { chromium } from "playwright-core";

const [url, out, spec] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1100, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  reducedMotion: "reduce", // animated figures render their final frame
});

if (out === "--list") {
  await page.goto(url, { waitUntil: "networkidle" });
  const rows = await page.evaluate(() => {
    const lines = [];
    for (const k of document.querySelector(".sl-markdown-content").children) {
      const h = k.matches(".sl-heading-wrapper") && k.querySelector("h2,h3,h4");
      if (h) (lines.push(`${h.tagName} ${h.id}`), (lines.n = 0));
      else if (lines.length) {
        const text = k.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
        lines.push(`   ${lines.n++}: ${k.tagName.toLowerCase()} ${text}`);
      }
    }
    return lines;
  });
  console.log(rows.join("\n"));
  await browser.close();
  process.exit(0);
}

const shots = JSON.parse(readFileSync(spec, "utf8"));
for (const [name, keep] of Object.entries(shots)) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: `
      header.header, .sidebar-pane, .right-sidebar-container, mobile-starlight-toc,
      .sl-anchor-link, .copy, footer { display: none !important }
      :root { --sl-content-width: 54rem }
      .main-pane { width: 100% !important }
      .main-frame { padding-inline-start: 0 !important; padding-top: 0 !important }
      .expressive-code pre { overflow: visible !important }
      .sl-markdown-content > * { margin-top: 1.25rem !important }
      .sl-markdown-content > .sl-heading-wrapper,
      .sl-markdown-content .sl-heading-wrapper h2 { border-top: 0 !important; padding-top: 0 !important }
    `,
  });
  const clip = await page.evaluate((keep) => {
    const root = document.querySelector(".sl-markdown-content");
    const kids = [...root.children];
    const indexes = keep.map(([id, i]) => {
      const heading = document.getElementById(id);
      if (!heading) throw new Error(`no heading #${id}`);
      const at = kids.indexOf(heading.closest(".sl-heading-wrapper"));
      return i === "h" ? at : at + 1 + i;
    });
    kids.forEach((k, i) => {
      if (!indexes.includes(i)) k.style.display = "none";
    });
    const first = kids[Math.min(...indexes)].getBoundingClientRect();
    const last = kids[Math.max(...indexes)].getBoundingClientRect();
    const box = root.getBoundingClientRect();
    return {
      x: box.left - 32,
      y: Math.max(0, first.top + scrollY - 32),
      width: box.width + 64,
      height: last.bottom - first.top + 64,
    };
  }, keep);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true, clip });
  console.log(`${out}/${name}.png`);
}
await browser.close();
