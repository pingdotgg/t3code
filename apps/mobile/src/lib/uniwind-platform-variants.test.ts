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
}

interface FixtureOutput {
  tailwindChecks: {
    iosBlocks: number;
    androidBlocks: number;
    iosUtilities: number;
    androidUtilities: number;
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

describe("uniwind platform variants compile per platform", () => {
  let output: FixtureOutput;

  beforeAll(() => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "uniwind-platform-"));
    try {
      // So `@import "tailwindcss"` and `@import "uniwind"` resolve like in the app.
      NodeFS.symlinkSync(
        NodeFS.realpathSync(new URL("../../node_modules", import.meta.url)),
        NodePath.join(tempDir, "node_modules"),
        "dir",
      );
      NodeFS.writeFileSync(
        NodePath.join(tempDir, "global.css"),
        '@import "tailwindcss";\n@import "uniwind";\n',
      );
      NodeFS.writeFileSync(NodePath.join(tempDir, "Probe.tsx"), FIXTURE_SOURCE);

      const fixture = NodeURL.fileURLToPath(
        new URL("./uniwind-platform-variants.fixture.cjs", import.meta.url),
      );
      const stdout = NodeChildProcess.execFileSync(process.execPath, [fixture, tempDir], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
      });
      output = JSON.parse(stdout) as FixtureOutput;
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
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
