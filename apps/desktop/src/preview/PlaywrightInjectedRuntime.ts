// @effect-diagnostics nodeBuiltinImport:off - Extracts Playwright's installed Node bundle for browser injection.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const require = NodeModule.createRequire(import.meta.url);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const PLAYWRIGHT_PACKAGE_SPECIFIER = "playwright-core/package.json";
const PLAYWRIGHT_SOURCE_MARKER = "source3 = ";
const PLAYWRIGHT_SOURCE_TERMINATOR = ";\n  }\n});";
const PLAYWRIGHT_SOURCE_MINIMUM_LENGTH = 100_000;
const PLAYWRIGHT_SOURCE_EVALUATION_TIMEOUT_MS = 1_000;
const PLAYWRIGHT_SDK_LANGUAGE = "javascript";
const PLAYWRIGHT_BROWSER_NAME = "chromium";

export class PlaywrightPackageResolveError extends Schema.TaggedErrorClass<PlaywrightPackageResolveError>()(
  "PlaywrightPackageResolveError",
  {
    specifier: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve Playwright package: ${this.specifier}`;
  }
}

export class PlaywrightCoreBundleReadError extends Schema.TaggedErrorClass<PlaywrightCoreBundleReadError>()(
  "PlaywrightCoreBundleReadError",
  {
    bundlePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read Playwright core bundle: ${this.bundlePath}`;
  }
}

export class PlaywrightSourceMarkerNotFoundError extends Schema.TaggedErrorClass<PlaywrightSourceMarkerNotFoundError>()(
  "PlaywrightSourceMarkerNotFoundError",
  {
    bundlePath: Schema.String,
    marker: Schema.String,
  },
) {
  override get message(): string {
    return `Playwright injected runtime marker ${JSON.stringify(this.marker)} was not found in ${this.bundlePath}`;
  }
}

export class PlaywrightSourceTerminatorNotFoundError extends Schema.TaggedErrorClass<PlaywrightSourceTerminatorNotFoundError>()(
  "PlaywrightSourceTerminatorNotFoundError",
  {
    bundlePath: Schema.String,
    terminator: Schema.String,
  },
) {
  override get message(): string {
    return `Playwright injected runtime terminator ${JSON.stringify(this.terminator)} was not found in ${this.bundlePath}`;
  }
}

export class PlaywrightSourceEvaluationError extends Schema.TaggedErrorClass<PlaywrightSourceEvaluationError>()(
  "PlaywrightSourceEvaluationError",
  {
    bundlePath: Schema.String,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to evaluate the Playwright injected runtime literal from ${this.bundlePath} within ${this.timeoutMs}ms`;
  }
}

export class PlaywrightSourceValidationError extends Schema.TaggedErrorClass<PlaywrightSourceValidationError>()(
  "PlaywrightSourceValidationError",
  {
    bundlePath: Schema.String,
    actualType: Schema.String,
    actualLength: Schema.NullOr(Schema.Number),
    minimumLength: Schema.Number,
  },
) {
  override get message(): string {
    const actual =
      this.actualLength === null
        ? this.actualType
        : `${this.actualType} with ${this.actualLength} characters`;
    return `Playwright injected runtime from ${this.bundlePath} was ${actual}; expected a string with at least ${this.minimumLength} characters`;
  }
}

export class PlaywrightOptionsEncodeError extends Schema.TaggedErrorClass<PlaywrightOptionsEncodeError>()(
  "PlaywrightOptionsEncodeError",
  {
    sdkLanguage: Schema.String,
    browserName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode ${this.browserName} Playwright injected runtime options for ${this.sdkLanguage}`;
  }
}

export const PlaywrightInjectedRuntimeError = Schema.Union([
  PlaywrightPackageResolveError,
  PlaywrightCoreBundleReadError,
  PlaywrightSourceMarkerNotFoundError,
  PlaywrightSourceTerminatorNotFoundError,
  PlaywrightSourceEvaluationError,
  PlaywrightSourceValidationError,
  PlaywrightOptionsEncodeError,
]);
export type PlaywrightInjectedRuntimeError = typeof PlaywrightInjectedRuntimeError.Type;

export const extractPlaywrightInjectedRuntimeSource = Effect.fn(
  "PlaywrightInjectedRuntime.extractSource",
)(function* (coreBundle: string, bundlePath: string) {
  const start = coreBundle.indexOf(PLAYWRIGHT_SOURCE_MARKER);
  if (start < 0) {
    return yield* new PlaywrightSourceMarkerNotFoundError({
      bundlePath,
      marker: PLAYWRIGHT_SOURCE_MARKER,
    });
  }
  const literalStart = start + PLAYWRIGHT_SOURCE_MARKER.length;
  const literalEnd = coreBundle.indexOf(PLAYWRIGHT_SOURCE_TERMINATOR, literalStart);
  if (literalEnd < 0) {
    return yield* new PlaywrightSourceTerminatorNotFoundError({
      bundlePath,
      terminator: PLAYWRIGHT_SOURCE_TERMINATOR,
    });
  }
  const literal = coreBundle.slice(literalStart, literalEnd);
  const source = yield* Effect.try({
    try: () =>
      NodeVM.runInNewContext(literal, Object.create(null), {
        timeout: PLAYWRIGHT_SOURCE_EVALUATION_TIMEOUT_MS,
      }),
    catch: (cause) =>
      new PlaywrightSourceEvaluationError({
        bundlePath,
        timeoutMs: PLAYWRIGHT_SOURCE_EVALUATION_TIMEOUT_MS,
        cause,
      }),
  });
  if (typeof source !== "string" || source.length < PLAYWRIGHT_SOURCE_MINIMUM_LENGTH) {
    return yield* new PlaywrightSourceValidationError({
      bundlePath,
      actualType: typeof source,
      actualLength: typeof source === "string" ? source.length : null,
      minimumLength: PLAYWRIGHT_SOURCE_MINIMUM_LENGTH,
    });
  }
  return source;
});

export const playwrightInjectedRuntimeSource = Effect.fn("PlaywrightInjectedRuntime.source")(
  function* () {
    const packageJsonPath = yield* Effect.try({
      try: () => require.resolve(PLAYWRIGHT_PACKAGE_SPECIFIER),
      catch: (cause) =>
        new PlaywrightPackageResolveError({
          specifier: PLAYWRIGHT_PACKAGE_SPECIFIER,
          cause,
        }),
    });
    const bundlePath = NodePath.join(NodePath.dirname(packageJsonPath), "lib/coreBundle.js");
    const coreBundle = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(bundlePath, "utf8"),
      catch: (cause) => new PlaywrightCoreBundleReadError({ bundlePath, cause }),
    });
    return yield* extractPlaywrightInjectedRuntimeSource(coreBundle, bundlePath);
  },
);

export const playwrightInjectedRuntimeInstallExpression = Effect.fn(
  "PlaywrightInjectedRuntime.installExpression",
)(function* () {
  const source = yield* playwrightInjectedRuntimeSource();
  const options = yield* encodeUnknownJson({
    isUnderTest: false,
    sdkLanguage: PLAYWRIGHT_SDK_LANGUAGE,
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: PLAYWRIGHT_BROWSER_NAME,
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PlaywrightOptionsEncodeError({
          sdkLanguage: PLAYWRIGHT_SDK_LANGUAGE,
          browserName: PLAYWRIGHT_BROWSER_NAME,
          cause,
        }),
    ),
  );
  return `(() => {
    if (globalThis.__t3PlaywrightInjected) return true;
    const module = { exports: {} };
    ${source}
    globalThis.__t3PlaywrightInjected = new (module.exports.InjectedScript())(globalThis, ${options});
    return true;
  })()`;
});
