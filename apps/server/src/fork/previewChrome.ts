import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { PreviewBrowserRelease } from "../preview/PreviewBrowser.ts";

// Full Chrome for Testing, which the preview browser's "xvfb" mode runs (see previewBrowserMode.ts).
// macOS keeps the shell: the Chrome app bundle holds symlinks the installer will not unpack.
// Pin from each chrome zip in known-good-versions-with-downloads.json, at PreviewBrowser.VERSION:
// the browser's --user-agent names that version in both modes.
const VERSION = "157.0.8103.78";
const ARCHIVES: Partial<Record<string, { readonly bytes: number; readonly sha256: string }>> = {
  linux64: {
    bytes: 203_266_906,
    sha256: "9223832977a13db3646201b1341c1f9cf08afa3ceae92540116d7b0c062364fb",
  },
  "linux-arm64": {
    bytes: 203_144_198,
    sha256: "f354d666822a11d8fe99e923c44be77dd226fab2750c5b5947e6318818bf10f1",
  },
  win32: {
    bytes: 190_974_375,
    sha256: "313261468c4b205198778b112c9ac6e44dff0ff501085b0f9336d7feae2b3715",
  },
  win64: {
    bytes: 209_854_321,
    sha256: "5f6ec40206407112702e163bf694d07f9fdc8ccbd346c70ce61fa62f716493f9",
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
