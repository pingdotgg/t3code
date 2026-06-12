// @effect-diagnostics nodeBuiltinImport:off
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
let sourcePromise: Promise<string> | null = null;

export const playwrightInjectedRuntimeSource = (): Promise<string> => {
  sourcePromise ??= (async () => {
    const packageJsonPath = require.resolve("playwright-core/package.json");
    const coreBundle = await readFile(join(dirname(packageJsonPath), "lib/coreBundle.js"), "utf8");
    const marker = "source3 = ";
    const start = coreBundle.indexOf(marker);
    if (start < 0) throw new Error("Playwright injected runtime marker was not found.");
    const literalStart = start + marker.length;
    const literalEnd = coreBundle.indexOf(";\n  }\n});", literalStart);
    if (literalEnd < 0) throw new Error("Playwright injected runtime terminator was not found.");
    const literal = coreBundle.slice(literalStart, literalEnd);
    const source = runInNewContext(literal, Object.create(null), { timeout: 1_000 });
    if (typeof source !== "string" || source.length < 100_000) {
      throw new Error("Playwright injected runtime extraction returned invalid source.");
    }
    return source;
  })();
  return sourcePromise;
};

export const playwrightInjectedRuntimeInstallExpression = async (): Promise<string> => {
  const source = await playwrightInjectedRuntimeSource();
  const options = {
    isUnderTest: false,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  };
  return `(() => {
    if (globalThis.__t3PlaywrightInjected) return true;
    const module = { exports: {} };
    ${source}
    globalThis.__t3PlaywrightInjected = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(options)});
    return true;
  })()`;
};
