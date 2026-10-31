// Captures web stills of the seeded usage-limit evidence threads (see usage-limit-web-evidence-seed.ts).
//   node usage-limit-web-evidence-stills.mjs <pairingUrl> <outDir> <label> [rows]
// Resolves playwright from apps/web. Every usage-limit failure shown is a SYNTHETIC fixture.
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [pairingUrl, outDir, label, rowList = "W0,W1,W2,W7,W8"] = process.argv.slice(2);
if (!pairingUrl || !outDir || !label)
  throw new Error("usage: <pairingUrl> <outDir> <label> [rows]");
const require = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../../web/package.json"),
);
const { chromium } = require("playwright");
const rows = rowList.split(",");
const variants = [
  { width: 1440, height: 900, theme: "light" },
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
];
NodeFS.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const origin = new URL(pairingUrl).origin;
const pairContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await pairContext.newPage();
await page.goto(pairingUrl);
await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 180_000 });
const urls = {};
for (const row of rows) {
  const title = page.getByText(new RegExp(`^${row} `)).first();
  await title.waitFor({ timeout: 60_000 });
  await title.click();
  await page.waitForURL((url) => url.pathname.includes(encodeURIComponent(`evidence:${row}`)), {
    timeout: 60_000,
  });
  urls[row] = page.url();
}
const storageState = await pairContext.storageState();
await pairContext.close();
const env = { browser: `chromium ${browser.version()}`, node: process.version, origin, label };
const shots = [];
for (const variant of variants) {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: variant.theme,
    storageState,
  });
  const tab = await context.newPage();
  for (const row of rows) {
    await tab.goto(urls[row]);
    await tab.waitForLoadState("networkidle").catch(() => {});
    await tab.waitForTimeout(2500);
    const file = NodePath.join(outDir, `${row}-${variant.width}-${variant.theme}-${label}.png`);
    await tab.screenshot({ path: file });
    shots.push({ row, ...variant, file, at: new Date().toISOString() });
  }
  await context.close();
}
NodeFS.writeFileSync(
  NodePath.join(outDir, `shots-${label}.json`),
  JSON.stringify({ env, urls, shots }, null, 2),
);
await browser.close();
console.log(JSON.stringify({ env, count: shots.length }));
