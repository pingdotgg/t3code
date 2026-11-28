import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Community theme download counts use the selected app language",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    const api = "https://open-vsx.org/api";
    const detail = `${api}/demo/night`;
    const files = {
      manifest: `${detail}/manifest.json`,
      download: `${detail}/night.vsix`,
      sha256: `${detail}/night.sha256`,
    };
    await browser.route(/^https:\/\/open-vsx\.org\/api\/-\/search\?/, (route) =>
      route.fulfill({ json: { extensions: [{ namespace: "demo", name: "night" }] } }),
    );
    await browser.route(detail, (route) =>
      route.fulfill({
        json: {
          namespace: "demo",
          name: "night",
          displayName: "Fixture Night",
          version: "1.0.0",
          license: "MIT",
          downloadCount: 1_200_000,
          files,
        },
      }),
    );
    await browser.route(files.manifest, (route) =>
      route.fulfill({
        json: { license: "MIT", contributes: { themes: [{ path: "./night.json" }] } },
      }),
    );
    await browser.route(files.download, (route) => route.fulfill({ status: 200 }));

    const result = browser.locator("article").filter({ hasText: "Fixture Night" });
    const downloads = result.getByText(/downloads/i);
    await t3.open("/settings/appearance");
    await screen.getByRole("button", "Add theme", { exact: true }).tap();
    await screen.getByRole("searchbox").fill("night");
    await downloads.waitFor();
    await expect(await downloads.textContent()).toBe("demo · 1.2M downloads");

    await t3.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("Deutsch", { exact: true }).tap();
    await screen.getByLabel("Sprache", { exact: true }).waitFor();
    await t3.open("/settings/appearance");

    await screen.getByRole("button", "Design hinzufügen", { exact: true }).tap();
    await screen.getByRole("searchbox").fill("night");
    await downloads.waitFor();
    await app.screenshot("german-theme-download-count");
    await expect(await downloads.textContent()).toMatch(/1,2\s+Mio\./);
  },
);
