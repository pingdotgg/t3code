// Personal fork branding: "T3 Code L" with the nightly logo, sharing the official app's data
// (~/.t3 and the t3code-v2 Chromium profile). Run from the repo root on a throwaway checkout
// before `scripts/build-desktop-artifact.ts`; it rewrites tracked files and must not be committed.
import * as NodeFS from "node:fs";

const NAME = "T3 Code L";
const APP_ID = "com.lamarcab76.t3code.l";

function replaceOnce(path, from, to) {
  const text = NodeFS.readFileSync(path, "utf8");
  if (text.split(from).length !== 2) throw new Error(`${path}: expected exactly one "${from}"`);
  NodeFS.writeFileSync(path, text.replace(from, to));
}

replaceOnce(
  "apps/desktop/src/app/DesktopEnvironment.ts",
  'const APP_BASE_NAME = "T3 Code";',
  `const APP_BASE_NAME = "${NAME}";`,
);
replaceOnce(
  "apps/desktop/src/app/DesktopEnvironment.ts",
  "displayName: `${APP_BASE_NAME} (${stageLabel})`,",
  "displayName: APP_BASE_NAME,",
);
replaceOnce(
  "apps/desktop/src/app/DesktopAppIdentity.ts",
  "`${environment.branding.baseName} ${environment.branding.stageLabel}`,",
  "environment.displayName,",
);
replaceOnce(
  "scripts/build-desktop-artifact.ts",
  'const DESKTOP_APP_ID = "com.t3tools.t3code";',
  `const DESKTOP_APP_ID = "${APP_ID}";`,
);
replaceOnce("apps/desktop/src/app/DesktopEnvironment.ts", '"com.t3tools.t3code"', `"${APP_ID}"`);
replaceOnce(
  "apps/desktop/package.json",
  '"productName": "T3 Code (Beta)"',
  `"productName": "${NAME}"`,
);

const icons = [
  ["nightly-macos-1024.png", "black-macos-1024.png"],
  ["nightly-universal-1024.png", "black-universal-1024.png"],
  ["nightly-windows.ico", "t3-black-windows.ico"],
  ["nightly-web-favicon.ico", "t3-black-web-favicon.ico"],
  ["nightly-web-favicon-16x16.png", "t3-black-web-favicon-16x16.png"],
  ["nightly-web-favicon-32x32.png", "t3-black-web-favicon-32x32.png"],
  ["nightly-web-apple-touch-180.png", "t3-black-web-apple-touch-180.png"],
  ["nightly-web-icon-192x192.png", "t3-black-web-icon-192x192.png"],
  ["nightly-web-icon-512x512.png", "t3-black-web-icon-512x512.png"],
];
for (const [from, to] of icons) NodeFS.copyFileSync(`assets/nightly/${from}`, `assets/prod/${to}`);

console.log(`Branded as ${NAME} (${APP_ID}) with the nightly logo.`);
