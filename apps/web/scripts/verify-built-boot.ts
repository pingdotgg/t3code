// @effect-diagnostics nodeBuiltinImport:off - plain Node script CI runs against the built client.
// Boots the built web client in headless Chromium and fails if it reaches showBootError.
// Source-level browser tests never run the production chunk graph, where boot breaks hide.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright";
import { APP_LOCALES, LOCALE_STORAGE_KEY } from "../src/i18n/locale.ts";

const distDir = NodeURL.fileURLToPath(new URL("../dist/", import.meta.url));
const origin = "http://t3-boot.test";
// With no server, the client retries its session for about 15s before it renders.
const timeoutMs = 60_000;

if (!NodeFS.existsSync(NodePath.join(distDir, "index.html"))) {
  console.error(`No web build at ${distDir}. Run the web build first.`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
  for (const locale of APP_LOCALES) {
    const page = await browser.newPage();
    try {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      // Serve dist with an SPA fallback; the client has no server here, so other requests fail fast.
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        const file = NodePath.join(distDir, decodeURIComponent(url.pathname));
        const isAsset =
          file.startsWith(distDir) && NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile();
        if (isAsset) return route.fulfill({ path: file });
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/")) {
          return route.fulfill({ status: 503 });
        }
        return route.fulfill({ path: NodePath.join(distDir, "index.html") });
      });

      await page.addInitScript(
        ({ locale, storageKey }) => {
          window.localStorage.setItem(storageKey, locale);
        },
        { locale, storageKey: LOCALE_STORAGE_KEY },
      );
      await page.goto(`${origin}/`);
      // React replaces the static #boot-shell splash when it mounts; showBootError fills it instead.
      const settled = await page.waitForSelector(
        '#root > :not(#boot-shell), #boot-error-reload, body > main[role="alert"]',
        {
          timeout: timeoutMs,
        },
      );

      const failed = await settled.evaluate(
        (node) => node.id === "boot-error-reload" || node.closest("#root") === null,
      );
      if (failed || (await page.locator("html").getAttribute("lang")) !== locale) {
        console.error(`The built web client failed to boot in ${locale}:`);
        for (const error of errors) console.error(error);
        process.exitCode = 1;
      } else {
        console.log(`The built web client booted and mounted React in ${locale}.`);
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
