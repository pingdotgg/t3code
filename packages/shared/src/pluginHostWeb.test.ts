import { describe, expect, it } from "vite-plus/test";

import {
  PLUGIN_HOST_IMPORT_MAP_MARKER,
  PLUGIN_HOST_LAYER_MARKER,
  getPluginHostShimSource,
  injectPluginHostHeadHtml,
  pluginHostImportMap,
} from "./pluginHostWeb.ts";

describe("pluginHostWeb", () => {
  it("injects the import map and bootstrap at head start once", () => {
    const html = "<html><head><title>T3</title></head><body></body></html>";

    const injected = injectPluginHostHeadHtml(html);
    const reinjected = injectPluginHostHeadHtml(injected);

    expect(injected).toContain(PLUGIN_HOST_IMPORT_MAP_MARKER);
    expect(injected.indexOf(PLUGIN_HOST_IMPORT_MAP_MARKER)).toBeGreaterThan(
      injected.indexOf("<head>"),
    );
    expect(injected.indexOf(PLUGIN_HOST_IMPORT_MAP_MARKER)).toBeLessThan(
      injected.indexOf("</head>"),
    );
    // The `plugins` cascade-layer declaration must be injected into the head so it
    // is registered first (before any runtime CSS), keeping plugin styles lowest.
    expect(injected).toContain(`<style ${PLUGIN_HOST_LAYER_MARKER}>@layer plugins;</style>`);
    expect(reinjected.match(new RegExp(PLUGIN_HOST_IMPORT_MAP_MARKER, "g"))?.length).toBe(1);
  });

  it("injects the import map before a module script already present in the head", () => {
    // A built index.html carries the app's entry <script type="module"> in the
    // head; the browser ignores an import map that appears after it.
    const html =
      '<html><head lang="en"><title>T3</title><script type="module" src="/assets/index-abc.js"></script></head><body></body></html>';

    const injected = injectPluginHostHeadHtml(html);

    expect(injected.indexOf(PLUGIN_HOST_IMPORT_MAP_MARKER)).toBeLessThan(
      injected.indexOf('<script type="module" src="/assets/index-abc.js">'),
    );
  });

  it("maps host singleton specifiers to same-origin shim modules", () => {
    expect(pluginHostImportMap.imports).toMatchObject({
      "@effect/atom-react": "/plugin-host/@effect/atom-react.js",
      "@t3tools/plugin-sdk-web": "/plugin-host/@t3tools/plugin-sdk-web.js",
      effect: "/plugin-host/effect.js",
      react: "/plugin-host/react.js",
      "react-dom": "/plugin-host/react-dom.js",
      "react-dom/client": "/plugin-host/react-dom/client.js",
      "react/jsx-dev-runtime": "/plugin-host/react/jsx-dev-runtime.js",
      "react/jsx-runtime": "/plugin-host/react/jsx-runtime.js",
    });
  });

  it("generates static named exports for shim modules", () => {
    const source = getPluginHostShimSource("react");

    expect(source).toContain('const m = globalThis.__T3_PLUGIN_HOST__["react"];');
    expect(source).toContain("export default m.default ?? m;");
    expect(source).toContain("export const useState = m.useState;");
  });
});
