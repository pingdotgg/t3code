import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { PreviewBrowserRelease } from "../preview/PreviewBrowser.ts";

// Full Chrome for Testing, which the preview browser's "xvfb" mode runs (see previewBrowserMode.ts).
// macOS keeps the shell: the Chrome app bundle holds symlinks the installer will not unpack.
// Pin from each chrome zip in known-good-versions-with-downloads.json, at PreviewBrowser.VERSION:
// the browser's --user-agent names that version in both modes.
const VERSION = "158.0.8127.36";
const ARCHIVES: Partial<Record<string, { readonly bytes: number; readonly sha256: string }>> = {
  linux64: {
    bytes: 208_062_943,
    sha256: "dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7",
  },
  "linux-arm64": {
    bytes: 205_790_900,
    sha256: "f811b64a50cbc73f94fda7b3f3b3bf62be5d9409b3207e6ead9b61e6706afffe",
  },
  win32: {
    bytes: 196_218_437,
    sha256: "427a02beb8887ceca6a1847dc67445580741c8c40bd15af334993d3a59863943",
  },
  win64: {
    bytes: 214_927_656,
    sha256: "6a8ad290952cc612c7777ffb3eb62f345539a2a1a8d440cfac190c6d36b34d2c",
  },
};

export const FULL_CHROME_PRODUCT = "chrome";

export const fullChromeRelease = (platform: string): PreviewBrowserRelease | null => {
  const archive = ARCHIVES[platform];
  return archive === undefined
    ? null
    : {
        version: VERSION,
        platform,
        product: FULL_CHROME_PRODUCT,
        executable: platform.startsWith("win") ? "chrome.exe" : "chrome",
        url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${platform}/chrome-${platform}.zip`,
        ...archive,
      };
};

export interface Brand {
  readonly brand: string;
  readonly version: string;
}

const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/**
 * Google Chrome's brand list for a major version, as Chromium's GenerateBrandVersionList builds
 * it: the GREASE brand (a fake name sites must accept) and the order follow from the major version.
 */
export const chromeBrands = (
  major: number,
  version: (brandVersion: string) => string,
): Array<Brand> => {
  const [grease, chromium, chrome] = BRAND_ORDERS[major % BRAND_ORDERS.length]!;
  const brands: Array<Brand> = [];
  brands[grease] = {
    brand: `Not${GREASE_CHARS[major % GREASE_CHARS.length]}A${GREASE_CHARS[(major + 1) % GREASE_CHARS.length]}Brand`,
    version: version(GREASE_VERSIONS[major % GREASE_VERSIONS.length]!),
  };
  brands[chromium] = { brand: "Chromium", version: version(String(major)) };
  brands[chrome] = { brand: "Google Chrome", version: version(String(major)) };
  return brands;
};

/**
 * Packages that full Chrome needs and chrome-headless-shell does not (libnss3 brings libsmime3),
 * and Xvfb for its display (see previewDisplay.ts).
 */
export const FULL_CHROME_DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libcups2t64", "libcups2"],
  ["libpango-1.0-0"],
  ["libcairo2"],
  ["xvfb"],
];

// What T3 wrote before full Chrome. Setup replaces it, and keeps any other profile as an administrator's.
export const HEADLESS_SHELL_PROFILE = `# Written by \`t3 browser setup\`: lets T3 Code's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile t3-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/t3-chrome-headless-shell>
}
`;

/** Whether setup writes the AppArmor profile at `path`: none is there, or an older T3 wrote it. */
export const profileNeedsWrite = Effect.fn("previewChrome.profileNeedsWrite")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return true;
  const profile = yield* fs.readFileString(path).pipe(Effect.option);
  return Option.getOrUndefined(profile) === HEADLESS_SHELL_PROFILE;
});
