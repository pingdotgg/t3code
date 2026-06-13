// @effect-diagnostics nodeBuiltinImport:off - Extracts Playwright's installed Node bundle for browser injection.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const require = createRequire(import.meta.url);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

export class PlaywrightInjectedRuntimeError extends Data.TaggedError(
  "PlaywrightInjectedRuntimeError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Playwright injected runtime operation failed: ${this.operation}`;
  }
}

const fail = (operation: string, cause: unknown) =>
  new PlaywrightInjectedRuntimeError({ operation, cause });

export const playwrightInjectedRuntimeSource = Effect.fn("PlaywrightInjectedRuntime.source")(
  function* () {
    const packageJsonPath = yield* Effect.try({
      try: () => require.resolve("playwright-core/package.json"),
      catch: (cause) => fail("resolvePackage", cause),
    });
    const coreBundle = yield* Effect.tryPromise({
      try: () => readFile(join(dirname(packageJsonPath), "lib/coreBundle.js"), "utf8"),
      catch: (cause) => fail("readCoreBundle", cause),
    });
    const marker = "source3 = ";
    const start = coreBundle.indexOf(marker);
    if (start < 0) {
      return yield* fail(
        "findSourceMarker",
        new Error("Playwright injected runtime marker was not found."),
      );
    }
    const literalStart = start + marker.length;
    const literalEnd = coreBundle.indexOf(";\n  }\n});", literalStart);
    if (literalEnd < 0) {
      return yield* fail(
        "findSourceTerminator",
        new Error("Playwright injected runtime terminator was not found."),
      );
    }
    const literal = coreBundle.slice(literalStart, literalEnd);
    const source = yield* Effect.try({
      try: () => runInNewContext(literal, Object.create(null), { timeout: 1_000 }),
      catch: (cause) => fail("evaluateSourceLiteral", cause),
    });
    if (typeof source !== "string" || source.length < 100_000) {
      return yield* fail(
        "validateSource",
        new Error("Playwright injected runtime extraction returned invalid source."),
      );
    }
    return source;
  },
);

export const playwrightInjectedRuntimeInstallExpression = Effect.fn(
  "PlaywrightInjectedRuntime.installExpression",
)(function* () {
  const source = yield* playwrightInjectedRuntimeSource();
  const options = yield* encodeUnknownJson({
    isUnderTest: false,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  }).pipe(Effect.mapError((cause) => fail("encodeOptions", cause)));
  return `(() => {
    if (globalThis.__t3PlaywrightInjected) return true;
    const module = { exports: {} };
    ${source}
    globalThis.__t3PlaywrightInjected = new (module.exports.InjectedScript())(globalThis, ${options});
    return true;
  })()`;
});
