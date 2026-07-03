import { describe, expect, it } from "vite-plus/test";
import { getPluginHostShimSource, pluginHostShimExportNames } from "@t3tools/shared/pluginHostWeb";

import { getPluginHost, whenPluginHostReady } from "./hostSingletons";

describe("hostSingletons", () => {
  it("publishes the host singleton global with plugin import-map keys", async () => {
    const host = getPluginHost();
    await expect(whenPluginHostReady).resolves.toBe(host);

    expect(Object.keys(host).sort()).toEqual([
      "@effect/atom-react",
      "@t3tools/plugin-sdk-web",
      "effect",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
    ]);
    expect(host.react.version).toBe("19.2.6");
    expect(typeof host["@t3tools/plugin-sdk-web"].hostCompat).toBe("object");
  });

  it("react shim modules re-export the host singleton identities", async () => {
    const currentHost = getPluginHost();
    const hostReact = {
      default: { marker: "react-default" },
      useState: () => ["state"],
      version: "test-react",
    };
    globalThis.__T3_PLUGIN_HOST__ = {
      ...currentHost,
      react: hostReact as unknown as typeof currentHost.react,
    };

    const source = getPluginHostShimSource("react");
    const shim = (await import(
      /* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}#react-shim-test`
    )) as typeof import("react") & { readonly default: unknown };

    expect(shim.default).toBe(hostReact.default);
    expect(shim.useState).toBe(hostReact.useState);
    expect(shim.version).toBe("test-react");

    globalThis.__T3_PLUGIN_HOST__ = currentHost;
  });

  // Drift guard: the shim export-name lists are static snapshots of the host
  // modules. If a dependency bump adds or removes an export, a shim's
  // `export const X = m.X` silently yields undefined. Assert the snapshots
  // still match the modules the host actually ships (this app package has the
  // real deps, so a bump that drops a listed export fails CI here).
  it("shim export names match the host modules the app actually ships", async () => {
    const host = getPluginHost();
    for (const [specifier, names] of Object.entries(pluginHostShimExportNames)) {
      const module = host[specifier as keyof typeof host] as Record<string, unknown>;
      const actual = new Set(Object.keys(module));
      const missing = names.filter((name) => !actual.has(name));
      expect(missing, `stale shim exports for ${specifier}`).toEqual([]);
    }
  });

  // The generated shim must re-export the SAME identities the host holds for
  // every module — not just react — so a plugin gets one effect/atom/sdk-web
  // instance shared with the host.
  it("every host module's shim re-exports the host's own identity", async () => {
    const currentHost = getPluginHost();
    const marker = Symbol("host-identity");
    for (const [specifier, names] of Object.entries(pluginHostShimExportNames)) {
      const probeName = names[0];
      if (!probeName) continue;
      const realModule = currentHost[specifier as keyof typeof currentHost] as Record<
        string,
        unknown
      >;
      const stub = { ...realModule, [probeName]: { [marker]: specifier } };
      globalThis.__T3_PLUGIN_HOST__ = {
        ...currentHost,
        [specifier]: stub,
      } as typeof currentHost;

      const source = getPluginHostShimSource(specifier as keyof typeof pluginHostShimExportNames);
      const shim = (await import(
        /* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}#${encodeURIComponent(specifier)}`
      )) as Record<string, unknown>;

      expect(shim[probeName], `shim identity mismatch for ${specifier}.${probeName}`).toBe(
        stub[probeName],
      );
    }
    globalThis.__T3_PLUGIN_HOST__ = currentHost;
  });
});
