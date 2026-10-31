// Records one seeded usage-limit evidence thread (see usage-limit-web-evidence-seed.ts) at 1440 light.
//   node usage-limit-web-evidence-record.mjs <pairingUrl> <row> <outDir> <label> <action> [seconds]
// action: watch (observe only) | resume (click the composer's "Resume thread" if present) |
// arm (click the banner's "Resume at reset").
// Writes <row>-<label>.webm plus a .captions.json of UTC-stamped steps. Usage limits are SYNTHETIC.
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [pairingUrl, row, outDir, label, action = "watch", seconds = "20"] = process.argv.slice(2);
if (!pairingUrl || !row || !outDir || !label) throw new Error("missing arguments");
const require = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../../web/package.json"),
);
const { chromium } = require("playwright");
const manifest = process.env.SEED_HOME
  ? JSON.parse(NodeFS.readFileSync(`${process.env.SEED_HOME}/fixture-${row}.json`, "utf8"))
  : null;
const captions = [];
const start = Date.now();
const caption = (text) => {
  const entry = {
    t: (Date.now() - start) / 1000,
    utc: new Date().toISOString(),
    resetAt: manifest?.resetAt ?? null,
    text,
  };
  captions.push(entry);
  console.log(JSON.stringify(entry));
};
const browser = await chromium.launch();
const pair = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pairPage = await pair.newPage();
await pairPage.goto(pairingUrl);
await pairPage.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 180_000 });
const title = pairPage.getByText(new RegExp(`^${row} `)).first();
await title.waitFor({ timeout: 60_000 });
await title.click();
await pairPage.waitForURL((url) => url.pathname.includes(encodeURIComponent(`evidence:${row}`)), {
  timeout: 60_000,
});
const threadUrl = pairPage.url();
const storageState = await pair.storageState();
await pair.close();
NodeFS.mkdirSync(outDir, { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "light",
  storageState,
  recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
caption(
  `[${label}] open ${row}: SYNTHETIC usage-limit fixture seeded (reset ${manifest?.resetAt ?? "?"})`,
);
await page.goto(threadUrl);
await page.getByText("Work on this.").first().waitFor({ timeout: 120_000 });
await page.waitForTimeout(3000);
const banner = async () =>
  (await page.getByText("Usage limit reached", { exact: true }).count()) > 0
    ? "banner shown"
    : "no banner";
caption(`[${label}] loaded: ${await banner()}; sidebar row ${row}`);
if (action === "arm") {
  const arm = page.getByRole("button", { name: "Resume at reset" });
  if ((await arm.count()) > 0) {
    caption(`[${label}] click "Resume at reset"`);
    await arm.first().click();
    await page.waitForTimeout(4000);
    const cancel = await page.getByRole("button", { name: "Cancel auto-resume" }).count();
    caption(`[${label}] after click: "Cancel auto-resume" ${cancel > 0 ? "shown" : "not shown"}`);
  } else {
    caption(`[${label}] "Resume at reset" button absent; nothing to click`);
  }
}
if (action === "resume") {
  const resume = page.getByRole("button", { name: /Resume thread/i });
  if ((await resume.count()) > 0) {
    caption(`[${label}] click "Resume thread"`);
    await resume.first().click();
    await page.waitForTimeout(6000);
    caption(
      `[${label}] after click: ${await banner()}; continuation message ${(await page.getByText("Continue where you left off").count()) > 0 ? "visible" : "not visible"}`,
    );
  } else {
    caption(`[${label}] "Resume thread" button absent; nothing to click`);
  }
}
const end = Date.now() + Number(seconds) * 1000;
while (Date.now() < end) {
  await page.waitForTimeout(5000);
  caption(`[${label}] ${await banner()}`);
}
const video = page.video();
await context.close();
const file = NodePath.join(outDir, `${row}-${label}.webm`);
NodeFS.renameSync(await video.path(), file);
NodeFS.writeFileSync(
  file.replace(/\.webm$/, ".captions.json"),
  JSON.stringify({ browser: browser.version(), threadUrl, captions }, null, 2),
);
await browser.close();
