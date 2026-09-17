import { createMiniflareFromRolldown } from "../../../../cloudflare-test-tools/src/miniflare/miniflare.ts";
import { assert, describe, expect, it } from "vitest";
import cloudflare from "../plugin.ts";
import { buildFixture } from "./utils/build-fixture.ts";

describe("nodejs_compat", () => {
  it("runs node builtin imports with nodejs_compat enabled", async () => {
    const built = await buildFixture({
      fixture: "node-compat/index.ts",
      pluginOptions: {
        compatibilityDate: "2025-07-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    });

    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
      compatibilityFlags: ["nodejs_compat"],
    });

    expect(await miniflare.fetchText("/")).toBe("OK!");
  });

  it("creates and injects virtual globals for nodejs_compat entries", async () => {
    const plugins = cloudflare({
      compatibilityDate: "2025-07-01",
      compatibilityFlags: ["nodejs_compat"],
    }) as Array<{
      name: string;
      resolveId?: { handler?: (...args: Array<unknown>) => unknown };
      load?: { handler?: (...args: Array<unknown>) => unknown };
      transform?: (code: string, id: string) => string | undefined;
      buildStart?: (options: { plugins: Array<unknown> }) => void;
    }>;

    const virtualModulesPlugin = plugins.find(
      (plugin) => plugin?.name === "distilled-cloudflare:virtual-modules",
    );

    assert(virtualModulesPlugin, "virtualModulesPlugin is not defined");

    virtualModulesPlugin.buildStart?.({ plugins: plugins.filter(Boolean) });

    const resolved = virtualModulesPlugin.resolveId?.handler?.(
      "\0distilled:inject:process",
    );
    expect(resolved).toEqual({ id: "\0distilled:inject:process" });

    const loaded = virtualModulesPlugin.load?.handler?.(
      "\0distilled:inject:process",
    );
    expect(loaded).toContain("globalThis.process = process;");

    const transformed = virtualModulesPlugin?.load?.handler?.(
      "\0distilled:worker-entry:test/fixtures/node-compat/index.ts",
    );

    expect(transformed).toContain(
      'import "@cloudflare/unenv-preset/polyfill/performance";',
    );
    expect(transformed).toContain('import "\0distilled:inject:process";');
  });

  it("warns when unresolved Node builtins are imported without nodejs_compat", async () => {
    const plugins = cloudflare({
      compatibilityDate: "2025-07-01",
    });

    const nodejsImportWarningPlugin = plugins.find(
      (plugin) => plugin?.name === "distilled-cloudflare:nodejs-import-warning",
    ) as unknown as {
      buildStart: () => void;
      resolveId: { handler: (...args: Array<any>) => unknown };
      buildEnd: () => void;
    };

    const warnings: Array<string> = [];
    nodejsImportWarningPlugin?.buildStart?.call({});

    await nodejsImportWarningPlugin?.resolveId?.handler?.call(
      {},
      "node:fs",
      "test/fixtures/example-a.ts",
      {},
    );
    await nodejsImportWarningPlugin?.resolveId?.handler?.call(
      {},
      "node:fs",
      "test/fixtures/example-b.ts",
      {},
    );

    nodejsImportWarningPlugin?.buildEnd?.call({
      warn(message: string) {
        warnings.push(message);
      },
      getModuleInfo() {
        return {};
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unexpected Node.js imports.");
    expect(warnings[0]).toContain(
      'Do you need to enable the "nodejs_compat" compatibility flag?',
    );
    expect(warnings[0]).toContain(
      "https://developers.cloudflare.com/workers/runtime-apis/nodejs/",
    );
    expect(warnings[0]).toContain(
      '- "node:fs" imported from "test/fixtures/example-a.ts"',
    );
    expect(warnings[0]).toContain(
      '- "node:fs" imported from "test/fixtures/example-b.ts"',
    );
  });
});
