import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import viteConfigSource from "../vite.config.ts?raw";
import reactGrabSource from "./lib/reactGrab.ts?raw";
import reactGrabDevEntrySource from "./lib/reactGrabDevEntry.ts?raw";

const REACT_GRAB_REFERENCE = /(?:\bfrom\s*|\bimport\s*\(\s*)["']react-grab["']/;

/**
 * A `react-grab` reference that survives to runtime — anything but a
 * `import type ... from "react-grab"` line, which TypeScript erases entirely.
 */
function hasValueImportOfReactGrab(source: string): boolean {
  return source
    .split("\n")
    .some((line) => REACT_GRAB_REFERENCE.test(line) && !/^\s*import\s+type\b/.test(line));
}

/**
 * React Grab instruments React and installs a global overlay with its own
 * hotkeys, so it must never reach a shipped renderer. Only `reactGrabDevEntry.ts`
 * imports the package, and only `vite dev`'s `reactGrabDevPlugin` (apply:
 * "serve") ever references that file — it injects it as a script tag, nothing
 * in application source imports it — so a production build has no path to the
 * package and Rollup never sees it.
 *
 * `reactGrab.ts` is the settings bridge that ships in every build; it must
 * stay import-free of the package and only reach the overlay through the
 * global the dev entry publishes.
 */
describe("React Grab runtime boundary", () => {
  it("keeps React Grab out of the production dependency graph", () => {
    expect(packageJson.dependencies).not.toHaveProperty("react-grab");
    expect(packageJson.devDependencies).toHaveProperty("react-grab");
  });

  it("keeps the shipped settings bridge free of a runtime overlay import", () => {
    expect(hasValueImportOfReactGrab(reactGrabSource)).toBe(false);
  });

  it("only the dev-only entry module imports the overlay package at runtime", () => {
    expect(hasValueImportOfReactGrab(reactGrabDevEntrySource)).toBe(true);
  });

  it("only vite dev serves the dev entry, and only in serve mode", () => {
    const pluginBody = viteConfigSource.slice(
      viteConfigSource.indexOf("function reactGrabDevPlugin"),
      viteConfigSource.indexOf("function reactGrabDevPlugin") + 800,
    );
    expect(pluginBody).toMatch(/apply:\s*["']serve["']/);
    expect(pluginBody).toMatch(/reactGrabDevEntry\.ts/);
  });
});
