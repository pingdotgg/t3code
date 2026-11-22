// Drives the MacBook web client through the linked-environments story and freezes a beat at
// each step into <out>/beats. Needs serve.mjs running. Usage: drive.mjs <out-dir>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { saveBeat } from "../../scripts/snapshot.mjs";
import { openBrowser } from "../../scripts/stage-env.mjs";

const out = NodePath.resolve(process.argv[2] ?? "");
const stage = JSON.parse(NodeFS.readFileSync(NodePath.join(out, "stage.json"), "utf8"));
NodeFS.rmSync(NodePath.join(out, "beats"), { recursive: true, force: true });
NodeFS.mkdirSync(NodePath.join(out, "shots"), { recursive: true });

const { browser, page } = await openBrowser();
const started = Date.now();
const beat = async (name) => {
  // Park the pointer off the app so no hover state is frozen in.
  await page.mouse.move(1439, 719);
  await page.waitForTimeout(250);
  await saveBeat(page, out, name);
  await page.screenshot({ path: NodePath.join(out, "shots", `${name}.png`) });
  console.log(`beat ${name} at ${((Date.now() - started) / 1000).toFixed(1)}s`);
};

try {
  await page.goto(stage.macbook.pairingUrl);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 120_000 });
  const composer = page.getByRole("textbox").first();
  await composer.waitFor({ timeout: 120_000 });
  await beat("ask-empty");

  await composer.click();
  await composer.pressSequentially("run the full e2e suite on devbox and tell me what breaks", {
    delay: 10,
  });
  await beat("ask-typed");
  await composer.press("Enter");

  const row = page
    .locator("main button, main a, main [role=button]")
    .filter({ hasText: "E2E suite" })
    .filter({ hasText: "on devbox" })
    .last();
  await row.waitFor({ timeout: 60_000 });
  await page.getByText("I'll tell you what fails", { exact: false }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
  await beat("delegated");

  console.log(`click at ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await row.click();
  // The devbox run streams for about 25 s: freeze it early, mid-run, and once it reports.
  await page.waitForTimeout(1500);
  await beat("watch-install");
  await page.waitForTimeout(6000);
  await beat("watch-e2e");
  await page.waitForTimeout(6000);
  await beat("watch-e2e-late");
  await page.getByText("The other 142 passed", { exact: false }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await beat("watch-done");

  await page.getByRole("button", { name: "Connect to interact" }).click();
  await page.waitForTimeout(150);
  await beat("connecting");
  const reply = page.getByRole("textbox").first();
  await page.waitForFunction(() => !document.body.innerText.includes("Connect to interact"), null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1500);
  await beat("connected");

  await reply.click();
  await reply.pressSequentially("fix the coupon rounding and rerun checkout.spec", { delay: 10 });
  await beat("reply-typed");
  await reply.press("Enter");
  await page.waitForTimeout(1500);
  await beat("reply-sent");
} catch (error) {
  await page.screenshot({ path: NodePath.join(out, "shots", "failure.png") });
  throw error;
} finally {
  await browser.close();
}
