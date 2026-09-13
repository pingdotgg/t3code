import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { greeting, LIB_VERSION } from "../lib/src/greeting.ts";

const FIXTURE_ROOT = NodePath.join(import.meta.dirname, "..");
const LIB_ROOT = NodePath.join(FIXTURE_ROOT, "lib");
const BUILD_JSON = NodePath.join(FIXTURE_ROOT, "dist", "build.json");

for (const method of Playwright.SERVER_METHODS) {
  test.describe(method, () => {
    const it = Playwright.make(method);

    it("renders SSR content imported across the workspace boundary", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#greeting")).toHaveText(greeting("ssr"));
      await expect(page.locator("#lib-version")).toHaveText(LIB_VERSION);
    });

    it("serves the JSON api backed by lib", async ({ server }) => {
      const body = await server.fetchJson<{ greeting: string; libVersion: string }>(
        "/api/greeting",
      );
      expect(body.greeting).toBe(greeting("api"));
      expect(body.libVersion).toBe(LIB_VERSION);
    });
  });
}

// The real assertion of this fixture: the build-output collector classifies
// lib/ (a sibling of the app's Vite root, with its own package.json) as an
// external workspace, persisted in dist/build.json. Runs under the `live`
// server fixture because that guarantees dist/build.json exists (live mode
// builds and persists it when absent).
test.describe("build output", () => {
  const it = Playwright.make("live");

  it("records lib/ in dist/build.json externalWorkspaces", async ({ server }) => {
    void server; // the live fixture guarantees the build ran and was persisted
    const parsed = JSON.parse(NodeFs.readFileSync(BUILD_JSON, "utf8")) as {
      externalWorkspaces?: Array<string>;
      serverModules?: Array<{ name: string }>;
    };
    // externalWorkspaces serializes as a sorted array of workspace roots
    // (framework-core stringifyBuildOutput).
    expect(parsed.externalWorkspaces ?? []).toContain(LIB_ROOT);
    // And the app root itself must NOT be classified as external.
    expect(parsed.externalWorkspaces ?? []).not.toContain(NodePath.join(FIXTURE_ROOT, "app"));
    expect(parsed.externalWorkspaces ?? []).not.toContain(FIXTURE_ROOT);
    // Sanity: the worker entry made it into the server modules.
    expect(parsed.serverModules?.length ?? 0).toBeGreaterThan(0);
  });

  // Memo-bust behavior ("editing lib/src busts the rebuild memo; an untouched
  // rebuild stays memoized") is deliberately NOT asserted here: the e2e
  // harness has no build memoization by design (`e2e build` rebuilds
  // unconditionally). The input-hash memo that consumes `externalWorkspaces`
  // lives in alchemy's `Website`/`Command.Memo` machinery, and the bust/keep
  // behavior over this exact fixture shape is asserted by
  // `alchemy/packages/alchemy/test/Cloudflare/Website/WorkspaceMemo.test.ts`.
  // This fixture pins the prerequisite: the collector reports `lib/` so the
  // memo layer has the right inputs (the assertion above).
});
