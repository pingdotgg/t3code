import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { beforeAll, describe, expect, it } from "vite-plus/test";

// Regression guard for the uniwind platform-variant leak (audit #15 / #13161):
// Tailwind groups every `ios:` (or `android:`) utility into one shared
// `@media ios { ... }` block, and uniwind's CSS processor used to drop the
// block's media queries after its first nested rule. Everything past the first
// utility compiled unguarded and shipped to both platforms. These tests run
// the installed (patched) uniwind compiler over real Tailwind output, per
// platform, and assert what each bundle receives. The compiler itself runs in
// a plain Node child process (uniwind-platform-variants.fixture.cjs) so no
// test-runner module transforms sit between the test and the shipped code.

interface CompiledStyle {
  native: boolean;
  minWidth: number;
  maxWidth: number;
  active: boolean | null;
  focus: boolean | null;
  disabled: boolean | null;
  dataAttributes: Record<string, string> | null;
}

interface FixtureOutput {
  tailwindChecks: {
    iosBlocks: number;
    androidBlocks: number;
    iosUtilities: number;
    androidUtilities: number;
  };
  transformerCheck: {
    reinitPayload: boolean;
    fingerprintArg: boolean;
    themesArg: boolean;
  };
  platforms: Record<
    string,
    {
      styles: Record<string, CompiledStyle[] | undefined>;
      payloadIncludesAllCompiled: boolean;
      payloadLeaks: string[];
    }
  >;
}

// Mirrors the classNames the audits flagged: multiple platform utilities per
// block (only the first one used to keep its guard), a base utility overridden
// by an `ios:` variant (NewTaskDraftScreen), and opposing `ios:`/`android:`
// font families (worktree-setup-card).
const FIXTURE_SOURCE = `export const Probe = () => (
  <div className="android:shrink android:grow-0 ios:flex-1 pt-12 ios:pt-[72px] ios:font-[family-name:Menlo] android:font-mono flex-1 sm:p-6 sm:text-lg" />
);
`;

const IOS_CLASSES = ["ios:flex-1", "ios:pt-[72px]", "ios:font-[family-name:Menlo]"];
const ANDROID_CLASSES = ["android:shrink", "android:grow-0", "android:font-mono"];
const SHARED_CLASSES = ["flex-1", "pt-12"];
const RESPONSIVE_CLASSES = ["sm:p-6", "sm:text-lg"];

const runFixture = (globalCss: string, probeSource: string): FixtureOutput => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "uniwind-platform-"));
  try {
    // So `@import "tailwindcss"` and `@import "uniwind"` resolve like in the app.
    NodeFS.symlinkSync(
      NodeFS.realpathSync(new URL("../../node_modules", import.meta.url)),
      NodePath.join(tempDir, "node_modules"),
      "dir",
    );
    NodeFS.writeFileSync(NodePath.join(tempDir, "global.css"), globalCss);
    NodeFS.writeFileSync(NodePath.join(tempDir, "Probe.tsx"), probeSource);

    const fixture = NodeURL.fileURLToPath(
      new URL("./uniwind-platform-variants.fixture.cjs", import.meta.url),
    );
    const stdout = NodeChildProcess.execFileSync(process.execPath, [fixture, tempDir], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    // The fixture's compiler may log warnings to stdout before the JSON payload.
    const start = stdout.indexOf('{"tailwindChecks"');
    if (start === -1) {
      throw new Error(`Fixture produced no JSON:\n${stdout}`);
    }
    return JSON.parse(stdout.slice(start)) as FixtureOutput;
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
};

describe("uniwind platform variants compile per platform", () => {
  let output: FixtureOutput;

  beforeAll(() => {
    output = runFixture('@import "tailwindcss";\n@import "uniwind";\n', FIXTURE_SOURCE);
  }, 60_000);

  it("compiles the fixture utilities into shared platform blocks", () => {
    // Without this grouping the leak could not happen and the assertions below
    // would prove nothing.
    expect(output.tailwindChecks).toEqual({
      iosBlocks: 1,
      androidBlocks: 1,
      iosUtilities: 3,
      androidUtilities: 3,
    });
  });

  it("keeps ios: utilities out of the android bundle and guards them on ios", () => {
    for (const className of IOS_CLASSES) {
      expect(
        output.platforms.android?.styles[className],
        `android has ${className}`,
      ).toBeUndefined();
      expect(output.platforms.ios?.styles[className], `ios lacks ${className}`).toBeDefined();
      expect(output.platforms.ios?.styles[className]?.every((style) => style.native)).toBe(true);
    }
  });

  it("keeps android: utilities out of the ios bundle and guards them on android", () => {
    for (const className of ANDROID_CLASSES) {
      expect(output.platforms.ios?.styles[className], `ios has ${className}`).toBeUndefined();
      expect(
        output.platforms.android?.styles[className],
        `android lacks ${className}`,
      ).toBeDefined();
      expect(output.platforms.android?.styles[className]?.every((style) => style.native)).toBe(
        true,
      );
    }
  });

  it("keeps shared and responsive utilities usable on both platforms", () => {
    for (const className of [...SHARED_CLASSES, ...RESPONSIVE_CLASSES]) {
      for (const platform of ["ios", "android"]) {
        const styles = output.platforms[platform]?.styles[className];
        expect(styles, `${platform} lacks ${className}`).toBeDefined();
        expect(styles?.every((style) => !style.native)).toBe(true);
      }
    }
    // The leak hid a second regression: only the first utility of a width
    // block kept its breakpoint, so the second applied at every screen size.
    for (const platform of ["ios", "android"]) {
      for (const className of RESPONSIVE_CLASSES) {
        const style = output.platforms[platform]?.styles[className]?.at(-1);
        expect(style?.minWidth, `${className} lost its breakpoint`).toBeGreaterThan(0);
      }
    }
  });

  it("serializes every compiled style into the platform payload and leaks nothing", () => {
    for (const platform of ["ios", "android"]) {
      expect(output.platforms[platform]?.payloadIncludesAllCompiled).toBe(true);
      // A platform utility dropped from this platform's stylesheet must not
      // survive anywhere in the payload this platform bundles.
      expect(output.platforms[platform]?.payloadLeaks, `${platform} payload leaks`).toEqual([]);
    }
  });
});

// The media-query fix must not lose the surrounding rule context: Tailwind
// also emits media rules *nested inside a class rule* (`@utility` bodies with
// `@variant`, nested breakpoints), and those declarations belong to the
// enclosing class. These expectations match the pre-fix compiler output for
// the same inputs, captured against the unpatched package.
describe("uniwind keeps media rules nested inside class rules attached to the class", () => {
  let nested: FixtureOutput;

  beforeAll(() => {
    nested = runFixture(
      [
        '@import "tailwindcss";',
        '@import "uniwind";',
        "",
        ".container-x {",
        "  width: 100%;",
        "  @media (width >= 40rem) {",
        "    max-width: 40rem;",
        "  }",
        "}",
        "",
        "@utility foo-x {",
        "  padding: 2px;",
        "  @variant ios {",
        "    padding: 3px;",
        "  }",
        "}",
        "",
      ].join("\n"),
      'export const Probe = () => <div className="container-x foo-x" />;\n',
    );
  }, 60_000);

  it("keeps the nested breakpoint entry of a nested media rule", () => {
    for (const platform of ["ios", "android"]) {
      const entries = nested.platforms[platform]?.styles["container-x"];
      expect(entries, `${platform} lacks container-x`).toBeDefined();
      expect(entries?.some((style) => !style.native && style.minWidth === 0)).toBe(true);
      expect(entries?.some((style) => !style.native && style.minWidth > 0)).toBe(true);
    }
  });

  it("keeps @variant declarations inside @utility on their platform", () => {
    const iosEntries = nested.platforms.ios?.styles["foo-x"];
    expect(iosEntries?.some((style) => !style.native)).toBe(true);
    expect(iosEntries?.some((style) => style.native)).toBe(true);

    const androidEntries = nested.platforms.android?.styles["foo-x"];
    expect(androidEntries?.some((style) => !style.native)).toBe(true);
    expect(androidEntries?.some((style) => style.native)).toBe(false);
  });
});

// The patch file carries three independent uniwind fixes (state/data selector
// variants, the Metro native-styles fingerprint, and this media-query scoping
// fix). Regenerating it for one fix must not silently drop the others — this
// suite exercises the shipped transformer and compiler for the other two.
describe("uniwind patch keeps pre-existing selector and transformer behavior", () => {
  let output: FixtureOutput;

  beforeAll(() => {
    output = runFixture(
      '@import "tailwindcss";\n@import "uniwind";\n',
      'export const Probe = () => <div className="active:opacity-50 disabled:opacity-50 data-x:underline aria-disabled:text-red-500" />;\n',
    );
  }, 60_000);

  it("keeps state and data variants conditioned, and rejects unsupported compounds", () => {
    for (const platform of ["ios", "android"]) {
      const styles = output.platforms[platform]?.styles;
      expect(styles?.["active:opacity-50"]?.every((style) => style.active === true)).toBe(true);
      expect(styles?.["disabled:opacity-50"]?.every((style) => style.disabled === true)).toBe(true);
      expect(styles?.["data-x:underline"]?.every((style) => style.dataAttributes?.["data-x"])).toBe(
        true,
      );
      // `[aria-disabled="true"]` is not expressible at runtime; emitting it
      // unconditionally (the pre-#9355 behavior) styles the element always.
      expect(styles).not.toHaveProperty("aria-disabled:text-red-500");
    }
  });

  it("emits the global.css virtual module with a native styles fingerprint", () => {
    expect(output.transformerCheck).toEqual({
      reinitPayload: true,
      fingerprintArg: true,
      themesArg: true,
    });
  });
});
